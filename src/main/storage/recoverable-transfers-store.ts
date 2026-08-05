import { rm } from 'node:fs/promises'
import { basename } from 'node:path'

import ElectronStore from 'electron-store'
import { z } from 'zod'

import { MAX_RECOVERABLE_TRANSFERS, RESUMABLE_TRANSFER_RETENTION_MS } from '@shared/constants'
import { deviceIdSchema, transferIdSchema } from '@shared/types'
import type { DeviceId, TransferId } from '@shared/types'

import type { SecretProtector } from './identity-store'
import { SecureStorageUnavailableError } from './identity-store'

const MAX_ENCRYPTED_RECOVERY_PAYLOAD_BYTES = 16 * 1_024 * 1_024

const encryptedPayloadSchema = z
  .string()
  .min(16)
  .max(MAX_ENCRYPTED_RECOVERY_PAYLOAD_BYTES * 2)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)

const recoveryEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    transferId: transferIdSchema,
    peerDeviceId: deviceIdSchema,
    kind: z.enum(['file', 'folder']),
    direction: z.enum(['send', 'receive']),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    encryptedPayload: encryptedPayloadSchema,
  })
  .strict()

const recoveryStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(recoveryEnvelopeSchema).max(MAX_RECOVERABLE_TRANSFERS),
  })
  .strict()

export interface RecoverableTransferEnvelope {
  readonly transferId: TransferId
  readonly peerDeviceId: DeviceId
  readonly kind: 'file' | 'folder'
  readonly direction: 'send' | 'receive'
  readonly updatedAt: number
  readonly expiresAt: number
}

export interface SaveRecoverableTransferRequest extends Omit<
  RecoverableTransferEnvelope,
  'updatedAt' | 'expiresAt'
> {
  readonly payload: unknown
  readonly stagingPaths?: readonly string[]
}

interface DecryptedRecoveryPayload {
  readonly payload: unknown
  readonly stagingPaths?: readonly string[]
}

export interface LoadedRecoverableTransfer extends RecoverableTransferEnvelope {
  readonly payload: unknown
  readonly stagingPaths: readonly string[]
}

export class RecoverableTransfersStore {
  private readonly store: ElectronStore<z.infer<typeof recoveryStoreSchema>>

  public constructor(
    directory: string,
    private readonly protector: SecretProtector,
  ) {
    if (!protector.isEncryptionAvailable()) throw new SecureStorageUnavailableError()
    this.store = new ElectronStore({ cwd: directory, name: 'recoverable-transfers' })
    if (this.store.size === 0) this.store.store = { schemaVersion: 1, records: [] }
    recoveryStoreSchema.parse(this.store.store)
  }

  public save(request: SaveRecoverableTransferRequest, now = Date.now()): void {
    const plaintext = JSON.stringify({
      payload: request.payload,
      ...(request.stagingPaths === undefined ? {} : { stagingPaths: request.stagingPaths }),
    } satisfies DecryptedRecoveryPayload)
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_ENCRYPTED_RECOVERY_PAYLOAD_BYTES) {
      throw new Error('Recoverable transfer payload is too large')
    }
    const envelope = recoveryEnvelopeSchema.parse({
      schemaVersion: 1,
      transferId: request.transferId,
      peerDeviceId: request.peerDeviceId,
      kind: request.kind,
      direction: request.direction,
      updatedAt: now,
      expiresAt: now + RESUMABLE_TRANSFER_RETENTION_MS,
      encryptedPayload: this.protector.encryptString(plaintext).toString('base64'),
    })
    const current = recoveryStoreSchema
      .parse(this.store.store)
      .records.filter((record) => record.transferId !== request.transferId)
    this.store.store = recoveryStoreSchema.parse({
      schemaVersion: 1,
      records: [envelope, ...current].slice(0, MAX_RECOVERABLE_TRANSFERS),
    })
  }

  public load(now = Date.now()): readonly LoadedRecoverableTransfer[] {
    const valid: LoadedRecoverableTransfer[] = []
    const retained: z.infer<typeof recoveryEnvelopeSchema>[] = []
    for (const envelope of recoveryStoreSchema.parse(this.store.store).records) {
      if (envelope.expiresAt <= now) continue
      try {
        const plaintext = this.protector.decryptString(
          Buffer.from(envelope.encryptedPayload, 'base64'),
        )
        const parsed = JSON.parse(plaintext) as unknown
        const decrypted = z
          .object({
            payload: z.unknown(),
            stagingPaths: z.array(z.string().min(1).max(32_768)).max(1_000).optional(),
          })
          .strict()
          .parse(parsed)
        retained.push(envelope)
        valid.push({
          transferId: envelope.transferId,
          peerDeviceId: envelope.peerDeviceId,
          kind: envelope.kind,
          direction: envelope.direction,
          updatedAt: envelope.updatedAt,
          expiresAt: envelope.expiresAt,
          payload: decrypted.payload,
          stagingPaths: decrypted.stagingPaths ?? [],
        })
      } catch {
        // 无法解密或解析的记录绝不能参与恢复。
      }
    }
    if (retained.length !== this.store.get('records').length) {
      this.store.set('records', retained)
    }
    return valid
  }

  public remove(transferId: TransferId): boolean {
    const records = recoveryStoreSchema.parse(this.store.store).records
    const retained = records.filter((record) => record.transferId !== transferId)
    if (retained.length === records.length) return false
    this.store.set('records', retained)
    return true
  }

  public async discard(transferId: TransferId): Promise<boolean> {
    const record = this.loadAllIncludingExpired().find(
      (candidate) => candidate.transferId === transferId,
    )
    if (record !== undefined) {
      for (const stagingPath of record.stagingPaths) {
        if (!this.isOwnedStagingPath(transferId, stagingPath)) continue
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return this.remove(transferId)
  }

  public async pruneExpired(now = Date.now()): Promise<number> {
    const records = recoveryStoreSchema.parse(this.store.store).records
    const expiredIds = new Set(
      records.filter((record) => record.expiresAt <= now).map((record) => record.transferId),
    )
    if (expiredIds.size === 0) return 0
    for (const record of this.loadAllIncludingExpired()) {
      if (!expiredIds.has(record.transferId)) continue
      for (const stagingPath of record.stagingPaths) {
        if (!this.isOwnedStagingPath(record.transferId, stagingPath)) continue
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    this.store.set(
      'records',
      records.filter((record) => !expiredIds.has(record.transferId)),
    )
    return expiredIds.size
  }

  private isOwnedStagingPath(transferId: TransferId, stagingPath: string): boolean {
    const name = basename(stagingPath)
    return (
      name === `.lindu-folder-${transferId}.part` ||
      (name.startsWith(`.lan-transfer-${transferId}-`) && name.endsWith('.part'))
    )
  }

  private loadAllIncludingExpired(): readonly LoadedRecoverableTransfer[] {
    const loaded: LoadedRecoverableTransfer[] = []
    for (const envelope of recoveryStoreSchema.parse(this.store.store).records) {
      try {
        const plaintext = this.protector.decryptString(
          Buffer.from(envelope.encryptedPayload, 'base64'),
        )
        const decrypted = z
          .object({
            payload: z.unknown(),
            stagingPaths: z.array(z.string().min(1).max(32_768)).max(1_000).optional(),
          })
          .strict()
          .parse(JSON.parse(plaintext) as unknown)
        loaded.push({
          transferId: envelope.transferId,
          peerDeviceId: envelope.peerDeviceId,
          kind: envelope.kind,
          direction: envelope.direction,
          updatedAt: envelope.updatedAt,
          expiresAt: envelope.expiresAt,
          payload: decrypted.payload,
          stagingPaths: decrypted.stagingPaths ?? [],
        })
      } catch {
        // 损坏记录留给调用方从索引中移除，不使用其中的路径。
      }
    }
    return loaded
  }
}
