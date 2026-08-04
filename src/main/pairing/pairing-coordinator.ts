import { randomUUID } from 'node:crypto'

import { PAIRING_CONFIRMATION_TIMEOUT_MS } from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import { publicIdentitySchema } from '@shared/protocols'
import { requestIdSchema } from '@shared/types'
import type {
  DeviceInfo,
  PairingRequestDto,
  PublicIdentityDto,
  RequestId,
  TrustedDeviceDto,
} from '@shared/types'

import { createPairingVerificationCode } from '../security'
import type { TrustDeviceResult } from '../storage'

export interface TrustedDeviceRegistry {
  get(deviceId: DeviceInfo['deviceId']): TrustedDeviceDto | null
  trust(
    deviceId: DeviceInfo['deviceId'],
    identity: PublicIdentityDto,
    verifiedAt?: number,
  ): TrustDeviceResult
}

export type BeginPairingResult =
  | { readonly state: 'trusted'; readonly device: TrustedDeviceDto }
  | { readonly state: 'pairingRequired'; readonly request: PairingRequestDto }
  | { readonly state: 'rejected'; readonly errorCode: 'IDENTITY_MISMATCH' | 'SIGNATURE_INVALID' }

export interface PairingCompletion {
  readonly requestId: RequestId
  readonly outcome: 'paired' | 'rejected' | 'timeout' | 'cancelled'
  readonly errorCode?: ErrorCode
}

export interface LocalPairingDecision {
  readonly requestId: RequestId
  readonly decision: 'accept' | 'reject'
}

interface PendingPairing {
  readonly request: PairingRequestDto
  readonly identity: PublicIdentityDto
  localAccepted: boolean
  peerAccepted: boolean
  timeout: ReturnType<typeof setTimeout>
}

type RequestListener = (request: PairingRequestDto) => void
type DecisionListener = (decision: LocalPairingDecision) => void
type CompletionListener = (completion: PairingCompletion) => void

export class PairingCoordinator {
  private pending: PendingPairing | null = null
  private readonly requestListeners = new Set<RequestListener>()
  private readonly decisionListeners = new Set<DecisionListener>()
  private readonly completionListeners = new Set<CompletionListener>()

  public constructor(private readonly trustedDevices: TrustedDeviceRegistry) {}

  public begin(
    peer: DeviceInfo,
    peerIdentity: PublicIdentityDto,
    confirmationKey: Uint8Array,
    requestId: RequestId = requestIdSchema.parse(randomUUID()),
  ): BeginPairingResult {
    this.cancel('CONNECTION_CLOSED')
    const identity = publicIdentitySchema.safeParse(peerIdentity)
    if (!identity.success) return { state: 'rejected', errorCode: 'SIGNATURE_INVALID' }
    const trusted = this.trustedDevices.get(peer.deviceId)
    if (trusted !== null) {
      if (trusted.identity.publicKey !== identity.data.publicKey) {
        return { state: 'rejected', errorCode: 'IDENTITY_MISMATCH' }
      }
      const refreshed = this.trustedDevices.trust(peer.deviceId, identity.data)
      return refreshed.ok
        ? { state: 'trusted', device: refreshed.device }
        : { state: 'rejected', errorCode: refreshed.errorCode }
    }

    const now = Date.now()
    const request: PairingRequestDto = {
      requestId,
      peer,
      peerFingerprint: identity.data.fingerprint,
      verificationCode: createPairingVerificationCode(confirmationKey),
      expiresAt: now + PAIRING_CONFIRMATION_TIMEOUT_MS,
    }
    const timeout = setTimeout(
      () => this.finish('timeout', 'PAIRING_TIMEOUT'),
      PAIRING_CONFIRMATION_TIMEOUT_MS,
    )
    timeout.unref()
    this.pending = {
      request,
      identity: identity.data,
      localAccepted: false,
      peerAccepted: false,
      timeout,
    }
    for (const listener of this.requestListeners) listener(request)
    return { state: 'pairingRequired', request }
  }

  public getPending(): PairingRequestDto | null {
    return this.pending?.request ?? null
  }

  public respond(requestId: RequestId, decision: 'accept' | 'reject'): boolean {
    const pending = this.pending
    if (pending === null || pending.request.requestId !== requestId) return false
    if (decision === 'accept' && pending.localAccepted) return true
    for (const listener of this.decisionListeners) listener({ requestId, decision })
    if (decision === 'reject') {
      this.finish('rejected', 'PAIRING_REJECTED')
      return true
    }
    pending.localAccepted = true
    this.completeIfConfirmed()
    return true
  }

  public confirmPeer(requestId: RequestId, decision: 'accept' | 'reject'): boolean {
    const pending = this.pending
    if (pending === null || pending.request.requestId !== requestId) return false
    if (decision === 'reject') {
      this.finish('rejected', 'PAIRING_REJECTED')
      return true
    }
    pending.peerAccepted = true
    this.completeIfConfirmed()
    return true
  }

  public cancel(errorCode: ErrorCode = 'CONNECTION_CLOSED'): void {
    if (this.pending !== null) this.finish('cancelled', errorCode)
  }

  public subscribeRequests(listener: RequestListener): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  public subscribeLocalDecisions(listener: DecisionListener): () => void {
    this.decisionListeners.add(listener)
    return () => this.decisionListeners.delete(listener)
  }

  public subscribeCompletions(listener: CompletionListener): () => void {
    this.completionListeners.add(listener)
    return () => this.completionListeners.delete(listener)
  }

  public shutdown(): void {
    this.cancel('CONNECTION_CLOSED')
    this.requestListeners.clear()
    this.decisionListeners.clear()
    this.completionListeners.clear()
  }

  private completeIfConfirmed(): void {
    const pending = this.pending
    if (pending === null || !pending.localAccepted || !pending.peerAccepted) return
    const result = this.trustedDevices.trust(pending.request.peer.deviceId, pending.identity)
    if (!result.ok) {
      this.finish('cancelled', result.errorCode)
      return
    }
    this.finish('paired')
  }

  private finish(outcome: PairingCompletion['outcome'], errorCode?: ErrorCode): void {
    const pending = this.pending
    if (pending === null) return
    clearTimeout(pending.timeout)
    this.pending = null
    const completion: PairingCompletion = {
      requestId: pending.request.requestId,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
    }
    for (const listener of this.completionListeners) listener(completion)
  }
}
