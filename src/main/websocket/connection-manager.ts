import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import WebSocket from 'ws'
import type { RawData } from 'ws'

import {
  CONNECTION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
  PROTOCOL_VERSION,
  RATE_LIMIT_WINDOW_MS,
} from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import {
  deviceDisconnectMessageSchema,
  deviceHeartbeatMessageSchema,
  fileAcceptMessageSchema,
  fileCancelMessageSchema,
  fileCompleteMessageSchema,
  fileErrorMessageSchema,
  fileProgressMessageSchema,
  fileRejectMessageSchema,
  folderAcceptMessageSchema,
  folderCancelMessageSchema,
  folderCompleteMessageSchema,
  folderErrorMessageSchema,
  folderManifestMessageSchema,
  folderOfferMessageSchema,
  folderProgressMessageSchema,
  folderRejectMessageSchema,
  pairingDecisionMessageSchema,
  parseProtocolMessage,
  parseSecureHandshakeMessage,
  secureChallengeMessageSchema,
  secureHelloMessageSchema,
  secureProofMessageSchema,
  secureFileOfferMessageSchema,
  textAcknowledgementMessageSchema,
  textSendMessageSchema,
} from '@shared/protocols'
import type {
  FileAcceptMessage,
  FileCancelMessage,
  FileCompleteMessage,
  FileErrorMessage,
  EncryptedChunkDescriptor,
  FileProgressMessage,
  FileRejectMessage,
  FolderAcceptMessage,
  FolderCancelMessage,
  FolderCompleteMessage,
  FolderErrorMessage,
  FolderManifestMessage,
  FolderOfferMessage,
  FolderProgressMessage,
  FolderRejectMessage,
  PairingDecisionMessage,
  SecureFileOfferMessage,
  SecureHelloMessage,
  SecureFileMetadata,
} from '@shared/protocols'
import {
  connectionIdSchema,
  messageIdSchema,
  requestIdSchema,
  transferIdSchema,
} from '@shared/types'
import type {
  ConnectionId,
  ConnectionStatusDto,
  DeviceInfo,
  FileId,
  IncomingConnectionRequestDto,
  MessageId,
  RequestId,
  PublicIdentityDto,
  TransferTaskDto,
  TransferId,
} from '@shared/types'
import type { TextReceivedDto } from '@shared/ipc'

import type { PairingCompletion, PairingCoordinator } from '../pairing'
import {
  createPairingRequestId,
  decryptFileChunk,
  deriveSecureSessionSecrets,
  deriveSharedSecret,
  encryptFileChunk,
  FixedWindowRateLimiter,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  SecureSessionCipher,
  SecureSequenceError,
  serializeSecureHandshakeTranscript,
  type SecureSessionSecrets,
} from '../security'
import { calculateIdentityFingerprint, verifyIdentitySignature } from '../storage'
import {
  isConnectedProtocolMessage,
  isMessageTimestampAllowed,
  MessageDeduplicator,
} from './protocol-state'

type StatusListener = (status: ConnectionStatusDto) => void
type RequestListener = (request: IncomingConnectionRequestDto) => void
type TextListener = (message: TextReceivedDto) => void
export type FileControlMessage =
  | SecureFileOfferMessage
  | FileAcceptMessage
  | FileRejectMessage
  | FileCancelMessage
  | FileProgressMessage
  | FileCompleteMessage
  | FileErrorMessage
type FileMessageListener = (message: FileControlMessage) => void
export type FolderControlMessage =
  | FolderOfferMessage
  | FolderManifestMessage
  | FolderAcceptMessage
  | FolderRejectMessage
  | FolderCancelMessage
  | FolderProgressMessage
  | FolderCompleteMessage
  | FolderErrorMessage
type FolderMessageListener = (message: FolderControlMessage) => void

interface PendingConnection {
  readonly requestId: RequestId
  readonly socket: WebSocket
  readonly peer: DeviceInfo
  readonly hello: SecureHelloMessage
  readonly timeout: ReturnType<typeof setTimeout>
}

interface SecureConnectionContext {
  readonly socket: WebSocket
  readonly peer: DeviceInfo
  readonly peerIdentity: PublicIdentityDto
  readonly connectionId: ConnectionId
  readonly pairingRequestId: RequestId
  readonly cipher: SecureSessionCipher
  readonly settle?: () => void
  localTrusted: boolean
}

export interface DeviceIdentitySigner {
  getPublicIdentity(): PublicIdentityDto
  sign(data: Uint8Array): string
}

interface PendingTextAcknowledgement {
  readonly complete: (succeeded: boolean) => void
}

const createMessageId = () => messageIdSchema.parse(randomUUID())
const createConnectionId = () => connectionIdSchema.parse(randomUUID())
const createRequestId = () => requestIdSchema.parse(randomUUID())
const createTransferId = () => transferIdSchema.parse(randomUUID())

const normalizeRemoteAddress = (address: string | undefined): string => {
  if (address === undefined) return '127.0.0.1'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

const mapConnectionError = (error: unknown): ErrorCode => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'ECONNREFUSED') return 'CONNECTION_REFUSED'
    if (error.code === 'ETIMEDOUT') return 'CONNECTION_TIMEOUT'
    if (error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH') {
      return 'NETWORK_UNREACHABLE'
    }
  }
  return 'CONNECTION_CLOSED'
}

export class ConnectionManager {
  private socket: WebSocket | null = null
  private pendingConnection: PendingConnection | null = null
  private status: ConnectionStatusDto = { state: 'disconnected' }
  private readonly statusListeners = new Set<StatusListener>()
  private readonly requestListeners = new Set<RequestListener>()
  private readonly textListeners = new Set<TextListener>()
  private readonly fileMessageListeners = new Set<FileMessageListener>()
  private readonly folderMessageListeners = new Set<FolderMessageListener>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private connectionId: ConnectionId | null = null
  private secureContext: SecureConnectionContext | null = null
  private fileRootKey: Buffer | null = null
  private peer: DeviceInfo | null = null
  private heartbeatSequence = 0
  private lastMessageAt = 0
  private readonly pendingTextAcknowledgements = new Map<MessageId, PendingTextAcknowledgement>()
  private readonly messageDeduplicator = new MessageDeduplicator()
  private readonly incomingMessageRateLimiter = new FixedWindowRateLimiter(
    MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
    RATE_LIMIT_WINDOW_MS,
    1,
  )

  public constructor(
    private readonly getLocalDevice: () => DeviceInfo,
    private readonly identityStore: DeviceIdentitySigner,
    private readonly pairingCoordinator: PairingCoordinator,
  ) {
    pairingCoordinator.subscribeLocalDecisions(({ requestId, decision }) => {
      const context = this.secureContext
      if (context === null || context.pairingRequestId !== requestId) return
      this.sendPairingDecision(decision)
    })
    pairingCoordinator.subscribeCompletions((completion) =>
      this.handlePairingCompletion(completion),
    )
  }

  public getStatus(): ConnectionStatusDto {
    return { ...this.status }
  }

  public subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  public subscribeRequests(listener: RequestListener): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  public subscribeText(listener: TextListener): () => void {
    this.textListeners.add(listener)
    return () => this.textListeners.delete(listener)
  }

  public subscribeFileMessages(listener: FileMessageListener): () => void {
    this.fileMessageListeners.add(listener)
    return () => this.fileMessageListeners.delete(listener)
  }

  public subscribeFolderMessages(listener: FolderMessageListener): () => void {
    this.folderMessageListeners.add(listener)
    return () => this.folderMessageListeners.delete(listener)
  }

  public sendFolderOffer(payload: FolderOfferMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:offer', folderOfferMessageSchema, payload)
  }

  public sendFolderManifest(payload: FolderManifestMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:manifest', folderManifestMessageSchema, payload)
  }

  public sendFolderAccept(payload: FolderAcceptMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:accept', folderAcceptMessageSchema, payload)
  }

  public sendFolderReject(payload: FolderRejectMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:reject', folderRejectMessageSchema, payload)
  }

  public sendFolderCancel(payload: FolderCancelMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:cancel', folderCancelMessageSchema, payload)
  }

  public sendFolderProgress(payload: FolderProgressMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:progress', folderProgressMessageSchema, payload)
  }

  public sendFolderComplete(payload: FolderCompleteMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:complete', folderCompleteMessageSchema, payload)
  }

  public sendFolderError(payload: FolderErrorMessage['payload']): Promise<boolean> {
    return this.sendFolderMessage('folder:error', folderErrorMessageSchema, payload)
  }

  public getPeer(): DeviceInfo | null {
    return this.peer === null ? null : { ...this.peer }
  }

  public encryptFileChunk(descriptor: EncryptedChunkDescriptor, plaintext: Buffer): Buffer | null {
    if (
      this.status.state !== 'connected' ||
      this.connectionId === null ||
      this.fileRootKey === null
    ) {
      return null
    }
    return encryptFileChunk(this.fileRootKey, this.connectionId, descriptor, plaintext)
  }

  public decryptFileChunk(descriptor: EncryptedChunkDescriptor, encrypted: Buffer): Buffer {
    if (
      this.status.state !== 'connected' ||
      this.connectionId === null ||
      this.fileRootKey === null
    ) {
      throw new Error('CONNECTION_CLOSED')
    }
    return decryptFileChunk(this.fileRootKey, this.connectionId, descriptor, encrypted)
  }

  public sendFileOffer(
    transferId: TransferId,
    files: readonly SecureFileMetadata[],
  ): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      secureFileOfferMessageSchema.parse({
        type: 'file:offer',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, files },
      }),
    )
  }

  public sendFileAccept(
    transferId: TransferId,
    files: FileAcceptMessage['payload']['files'],
  ): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileAcceptMessageSchema.parse({
        type: 'file:accept',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, files },
      }),
    )
  }

  public sendFileReject(
    transferId: TransferId,
    reason: FileRejectMessage['payload']['reason'] = 'user_rejected',
  ): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileRejectMessageSchema.parse({
        type: 'file:reject',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, reason },
      }),
    )
  }

  public sendFileProgress(
    transferId: TransferId,
    fileId: FileId,
    transferredBytes: number,
  ): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileProgressMessageSchema.parse({
        type: 'file:progress',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, fileId, transferredBytes },
      }),
    )
  }

  public sendFileCancel(transferId: TransferId, fileId?: FileId): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileCancelMessageSchema.parse({
        type: 'file:cancel',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: {
          transferId,
          ...(fileId === undefined ? {} : { fileId }),
          reason: 'user_cancelled',
        },
      }),
    )
  }

  public sendFileComplete(transferId: TransferId, fileId: FileId, size: number): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileCompleteMessageSchema.parse({
        type: 'file:complete',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, fileId, size },
      }),
    )
  }

  public sendFileError(
    transferId: TransferId,
    fileId: FileId,
    errorCode: ErrorCode,
  ): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      fileErrorMessageSchema.parse({
        type: 'file:error',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { transferId, fileId, errorCode },
      }),
    )
  }

  public async sendText(
    content: string,
    contentType: 'text' | 'link',
  ): Promise<TransferTaskDto | null> {
    const socket = this.socket
    const peer = this.peer
    if (
      socket === null ||
      peer === null ||
      this.status.state !== 'connected' ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return null
    }

    const localDevice = this.getLocalDevice()
    const now = Date.now()
    const messageId = createMessageId()
    const message = textSendMessageSchema.parse({
      type: 'text:send',
      messageId,
      senderId: localDevice.deviceId,
      timestamp: now,
      payload: { content, contentType },
    })
    const succeeded = await new Promise<boolean>((resolve) => {
      let settled = false
      const complete = (delivered: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.pendingTextAcknowledgements.delete(messageId)
        resolve(delivered)
      }
      const timeout = setTimeout(() => complete(false), CONNECTION_TIMEOUT_MS)
      this.pendingTextAcknowledgements.set(messageId, { complete })
      this.sendEncryptedMessage(message, (error) => {
        if (error) complete(false)
      })
    })

    return {
      transferId: createTransferId(),
      direction: 'send',
      kind: contentType,
      peer,
      status: succeeded ? 'completed' : 'failed',
      files: [],
      totalBytes: 0,
      transferredBytes: 0,
      bytesPerSecond: 0,
      createdAt: now,
      updatedAt: Date.now(),
      ...(succeeded ? {} : { errorCode: 'TRANSFER_FAILED' }),
    }
  }

  public acceptIncoming(socket: WebSocket, request: IncomingMessage): void {
    if (this.status.state !== 'disconnected' || this.pendingConnection !== null) {
      socket.close(1013, 'Another device connection is active')
      return
    }

    this.socket = socket
    this.setStatus({ state: 'connecting' })
    const timeout = setTimeout(() => {
      socket.close(1008, 'Handshake timeout')
      this.reset('CONNECTION_TIMEOUT')
    }, CONNECTION_TIMEOUT_MS)
    this.handshakeTimer = timeout

    socket.once('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('Binary protocol messages are forbidden')
        const message = parseSecureHandshakeMessage(JSON.parse(data.toString()))
        if (message.type !== 'secure:hello') throw new Error('Expected secure hello')
        if (message.senderId !== message.payload.device.deviceId) {
          throw new Error('Secure hello sender mismatch')
        }
        if (
          calculateIdentityFingerprint(message.payload.identity.publicKey) !==
          message.payload.identity.fingerprint
        ) {
          throw new Error('Secure hello fingerprint mismatch')
        }
        if (this.messageDeduplicator.isDuplicate(message.messageId)) {
          throw new Error('Duplicate secure hello')
        }
        if (!isMessageTimestampAllowed(message.timestamp)) throw new Error('Invalid timestamp')
        clearTimeout(timeout)
        this.handshakeTimer = null
        const peer = {
          ...message.payload.device,
          ipAddress: normalizeRemoteAddress(request.socket.remoteAddress),
        }
        const requestId = createRequestId()
        const approvalTimeout = setTimeout(() => {
          socket.close(1008, 'Connection approval timeout')
          this.pendingConnection = null
          this.reset('CONNECTION_TIMEOUT')
        }, CONNECTION_TIMEOUT_MS)
        const incomingRequest = { requestId, peer, receivedAt: Date.now() }
        this.pendingConnection = {
          requestId,
          socket,
          peer,
          hello: message,
          timeout: approvalTimeout,
        }
        this.setStatus({ state: 'awaitingApproval', peer, pendingRequest: incomingRequest })
        for (const listener of this.requestListeners) listener(incomingRequest)
      } catch {
        socket.close(1007, 'Invalid protocol message')
        this.reset('PROTOCOL_INVALID')
      }
    })
    socket.once('error', (error) => {
      if (this.socket === socket) this.reset(mapConnectionError(error))
    })
    socket.once('close', () => {
      if (this.socket === socket && this.status.state !== 'connected') this.reset()
    })
  }

  public async connect(host: string, port: number): Promise<ConnectionStatusDto> {
    if (this.status.state !== 'disconnected') {
      return this.getStatus()
    }

    this.setStatus({ state: 'connecting' })
    const socket = new WebSocket(`ws://${host}:${String(port)}/v1/ws`, {
      handshakeTimeout: CONNECTION_TIMEOUT_MS,
      perMessageDeflate: false,
    })
    this.socket = socket
    const ephemeralKeys = generateEphemeralKeyPair()
    const nonce = generateHandshakeNonce()
    const localIdentity = this.identityStore.getPublicIdentity()

    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (!settled) {
          settled = true
          resolve(this.getStatus())
        }
      }
      const timeout = setTimeout(() => {
        socket.terminate()
        this.reset('CONNECTION_TIMEOUT')
        settle()
      }, CONNECTION_TIMEOUT_MS)
      this.handshakeTimer = timeout

      socket.once('open', () => {
        const localDevice = this.getLocalDevice()
        const hello = secureHelloMessageSchema.parse({
          type: 'secure:hello',
          messageId: createMessageId(),
          senderId: localDevice.deviceId,
          timestamp: Date.now(),
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            device: localDevice,
            identity: localIdentity,
            keyAgreement: 'X25519',
            ephemeralPublicKey: ephemeralKeys.publicKey,
            nonce,
          },
        })
        socket.send(JSON.stringify(hello))
        this.setStatus({ state: 'awaitingApproval' })
      })

      socket.once('message', (data, isBinary) => {
        try {
          if (isBinary) throw new Error('Binary protocol messages are forbidden')
          const message = parseSecureHandshakeMessage(JSON.parse(data.toString()))
          if (message.type !== 'secure:challenge') throw new Error('Expected secure challenge')
          if (message.senderId !== message.payload.device.deviceId) {
            throw new Error('Secure challenge sender mismatch')
          }
          if (
            calculateIdentityFingerprint(message.payload.identity.publicKey) !==
            message.payload.identity.fingerprint
          ) {
            throw new Error('Secure challenge fingerprint mismatch')
          }
          if (this.messageDeduplicator.isDuplicate(message.messageId)) {
            throw new Error('Duplicate secure challenge')
          }
          if (!isMessageTimestampAllowed(message.timestamp)) throw new Error('Invalid timestamp')
          const localDevice = this.getLocalDevice()
          const peer = { ...message.payload.device, ipAddress: host }
          const transcript = serializeSecureHandshakeTranscript({
            initiatorDeviceId: localDevice.deviceId,
            responderDeviceId: peer.deviceId,
            initiatorNonce: nonce,
            responderNonce: message.payload.nonce,
            initiatorEphemeralPublicKey: ephemeralKeys.publicKey,
            responderEphemeralPublicKey: message.payload.ephemeralPublicKey,
            initiatorIdentity: localIdentity,
            responderIdentity: message.payload.identity,
          })
          if (
            !verifyIdentitySignature(
              message.payload.identity,
              transcript,
              message.payload.signature,
            )
          ) {
            socket.close(1008, 'Signature verification failed')
            this.reset('SIGNATURE_INVALID')
            settle()
            return
          }
          const sharedSecret = deriveSharedSecret(
            ephemeralKeys.privateKey,
            message.payload.ephemeralPublicKey,
          )
          const secrets = deriveSecureSessionSecrets(sharedSecret, transcript, 'initiator')
          sharedSecret.fill(0)
          const proof = secureProofMessageSchema.parse({
            type: 'secure:proof',
            messageId: createMessageId(),
            senderId: localDevice.deviceId,
            timestamp: Date.now(),
            payload: {
              protocolVersion: PROTOCOL_VERSION,
              connectionId: message.payload.connectionId,
              signature: this.identityStore.sign(transcript),
            },
          })
          clearTimeout(timeout)
          this.handshakeTimer = null
          socket.send(JSON.stringify(proof))
          this.startSecureAuthentication(
            socket,
            peer,
            message.payload.identity,
            message.payload.connectionId,
            createPairingRequestId(transcript),
            secrets,
            settle,
          )
        } catch {
          socket.close(1007, 'Invalid protocol message')
          this.reset('PROTOCOL_INVALID')
          settle()
        }
      })
      socket.once('error', (error) => {
        if (this.socket !== socket) return
        clearTimeout(timeout)
        this.handshakeTimer = null
        this.reset(mapConnectionError(error))
        settle()
      })
      socket.once('close', () => {
        if (this.socket === socket && this.status.state !== 'connected') {
          clearTimeout(timeout)
          this.reset(this.status.errorCode ?? 'CONNECTION_CLOSED')
          settle()
        }
      })
    })
  }

  public respondToRequest(
    requestId: RequestId,
    decision: 'accept' | 'reject',
  ): ConnectionStatusDto {
    const pending = this.pendingConnection
    if (pending === null || pending.requestId !== requestId) return this.getStatus()

    clearTimeout(pending.timeout)
    this.pendingConnection = null
    if (decision === 'reject') {
      pending.socket.close(1008, 'Connection rejected')
      this.reset('CONNECTION_REFUSED')
      return this.getStatus()
    }

    const connectionId = createConnectionId()
    const localDevice = this.getLocalDevice()
    const localIdentity = this.identityStore.getPublicIdentity()
    const ephemeralKeys = generateEphemeralKeyPair()
    const nonce = generateHandshakeNonce()
    const transcript = serializeSecureHandshakeTranscript({
      initiatorDeviceId: pending.peer.deviceId,
      responderDeviceId: localDevice.deviceId,
      initiatorNonce: pending.hello.payload.nonce,
      responderNonce: nonce,
      initiatorEphemeralPublicKey: pending.hello.payload.ephemeralPublicKey,
      responderEphemeralPublicKey: ephemeralKeys.publicKey,
      initiatorIdentity: pending.hello.payload.identity,
      responderIdentity: localIdentity,
    })
    const challenge = secureChallengeMessageSchema.parse({
      type: 'secure:challenge',
      messageId: createMessageId(),
      senderId: localDevice.deviceId,
      timestamp: Date.now(),
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        device: localDevice,
        identity: localIdentity,
        keyAgreement: 'X25519',
        ephemeralPublicKey: ephemeralKeys.publicKey,
        nonce,
        connectionId,
        signature: this.identityStore.sign(transcript),
      },
    })
    pending.socket.send(JSON.stringify(challenge))
    this.setStatus({ state: 'authenticating', peer: pending.peer })
    const timeout = setTimeout(() => {
      pending.socket.close(1008, 'Secure proof timeout')
      this.reset('CONNECTION_TIMEOUT')
    }, CONNECTION_TIMEOUT_MS)
    this.handshakeTimer = timeout
    pending.socket.once('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('Binary protocol messages are forbidden')
        const proof = parseSecureHandshakeMessage(JSON.parse(data.toString()))
        if (proof.type !== 'secure:proof') throw new Error('Expected secure proof')
        if (
          proof.senderId !== pending.peer.deviceId ||
          proof.payload.connectionId !== connectionId
        ) {
          throw new Error('Secure proof does not match the handshake')
        }
        if (this.messageDeduplicator.isDuplicate(proof.messageId)) {
          throw new Error('Duplicate secure proof')
        }
        if (!isMessageTimestampAllowed(proof.timestamp)) throw new Error('Invalid timestamp')
        if (
          !verifyIdentitySignature(
            pending.hello.payload.identity,
            transcript,
            proof.payload.signature,
          )
        ) {
          pending.socket.close(1008, 'Signature verification failed')
          this.reset('SIGNATURE_INVALID')
          return
        }
        const sharedSecret = deriveSharedSecret(
          ephemeralKeys.privateKey,
          pending.hello.payload.ephemeralPublicKey,
        )
        const secrets = deriveSecureSessionSecrets(sharedSecret, transcript, 'responder')
        sharedSecret.fill(0)
        clearTimeout(timeout)
        this.handshakeTimer = null
        this.startSecureAuthentication(
          pending.socket,
          pending.peer,
          pending.hello.payload.identity,
          connectionId,
          createPairingRequestId(transcript),
          secrets,
        )
      } catch {
        pending.socket.close(1007, 'Invalid secure proof')
        this.reset('PROTOCOL_INVALID')
      }
    })
    return this.getStatus()
  }

  public disconnect(reason: 'user_requested' | 'app_shutdown' = 'user_requested'): void {
    const socket = this.socket
    if (socket === null) return
    this.setStatus({ state: 'disconnecting', ...(this.peer === null ? {} : { peer: this.peer }) })
    if (
      socket.readyState === WebSocket.OPEN &&
      this.connectionId !== null &&
      this.status.state === 'connected'
    ) {
      const localDevice = this.getLocalDevice()
      this.sendEncryptedMessage(
        deviceDisconnectMessageSchema.parse({
          type: 'device:disconnect',
          messageId: createMessageId(),
          senderId: localDevice.deviceId,
          timestamp: Date.now(),
          payload: { connectionId: this.connectionId, reason },
        }),
      )
      socket.close(1000, 'Disconnected')
    } else {
      socket.terminate()
    }
    this.reset()
  }

  private startSecureAuthentication(
    socket: WebSocket,
    peer: DeviceInfo,
    peerIdentity: PublicIdentityDto,
    connectionId: ConnectionId,
    pairingRequestId: RequestId,
    secrets: SecureSessionSecrets,
    settle?: () => void,
  ): void {
    socket.removeAllListeners()
    this.socket = socket
    this.peer = peer
    this.connectionId = connectionId
    this.fileRootKey?.fill(0)
    this.fileRootKey = Buffer.from(secrets.fileRootKey)
    const cipher = new SecureSessionCipher(connectionId, secrets)
    this.secureContext = {
      socket,
      peer,
      peerIdentity,
      connectionId,
      pairingRequestId,
      cipher,
      ...(settle === undefined ? {} : { settle }),
      localTrusted: false,
    }
    socket.on('message', (data, isBinary) => this.handleSecureSocketMessage(data, isBinary))
    socket.once('error', (error) => {
      if (this.socket === socket) this.reset(mapConnectionError(error))
    })
    socket.once('close', () => {
      if (this.socket === socket) this.reset()
    })

    const pairing = this.pairingCoordinator.begin(
      peer,
      peerIdentity,
      secrets.confirmationKey,
      pairingRequestId,
    )
    for (const secret of [
      secrets.sendKey,
      secrets.receiveKey,
      secrets.fileRootKey,
      secrets.sendNoncePrefix,
      secrets.receiveNoncePrefix,
      secrets.confirmationKey,
    ]) {
      secret.fill(0)
    }
    if (pairing.state === 'rejected') {
      socket.close(1008, 'Device identity rejected')
      this.reset(pairing.errorCode)
      return
    }
    if (pairing.state === 'trusted') {
      this.secureContext.localTrusted = true
      this.setStatus({ state: 'authenticating', peer })
      this.sendPairingDecision('accept')
      return
    }
    this.setStatus({ state: 'pairingRequired', peer })
  }

  private activateSecureContext(): void {
    const context = this.secureContext
    if (context === null || this.status.state === 'connected') return
    this.lastMessageAt = Date.now()
    this.heartbeatSequence = 0
    this.setStatus({ state: 'connected', connectionId: context.connectionId, peer: context.peer })
    context.settle?.()
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS)
  }

  private handleSecureSocketMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.socket?.close(1007, 'Binary protocol messages are forbidden')
      this.reset('PROTOCOL_INVALID')
      return
    }
    if (!this.incomingMessageRateLimiter.allow('active-peer')) {
      this.socket?.close(1008, 'Message rate limit exceeded')
      this.reset('MESSAGE_INVALID')
      return
    }
    const context = this.secureContext
    if (context === null) {
      this.reset('CONNECTION_CLOSED')
      return
    }
    let decrypted: unknown
    try {
      decrypted = context.cipher.decrypt(JSON.parse(data.toString()))
    } catch (error) {
      this.socket?.close(1008, 'Encrypted message authentication failed')
      this.reset(error instanceof SecureSequenceError ? 'MESSAGE_REPLAYED' : 'DECRYPTION_FAILED')
      return
    }
    try {
      const pairingDecision = pairingDecisionMessageSchema.safeParse(decrypted)
      if (pairingDecision.success) {
        if (this.status.state === 'connected') {
          throw new Error('Unexpected pairing decision after authentication')
        }
        this.handlePeerPairingDecision(pairingDecision.data)
        return
      }
      if (this.status.state !== 'connected') {
        throw new Error('Business message received before pairing completed')
      }
      const secureFileOffer = secureFileOfferMessageSchema.safeParse(decrypted)
      if (secureFileOffer.success) {
        const message = secureFileOffer.data
        if (
          this.peer === null ||
          message.senderId !== this.peer.deviceId ||
          !isMessageTimestampAllowed(message.timestamp)
        ) {
          throw new Error('Invalid secure file offer')
        }
        if (this.messageDeduplicator.isDuplicate(message.messageId)) return
        this.lastMessageAt = Date.now()
        for (const listener of this.fileMessageListeners) listener(message)
        return
      }
      const message = parseProtocolMessage(decrypted)
      if (this.peer === null || message.senderId !== this.peer.deviceId) {
        throw new Error('Unexpected message sender')
      }
      if (!isConnectedProtocolMessage(message)) {
        throw new Error('Message type is not allowed while connected')
      }
      if (message.type === 'file:offer') {
        throw new Error('Unprotected file metadata is forbidden')
      }
      if (!isMessageTimestampAllowed(message.timestamp)) throw new Error('Invalid timestamp')
      if (this.messageDeduplicator.isDuplicate(message.messageId)) {
        if (message.type === 'text:send') this.sendTextAcknowledgement(message.messageId)
        return
      }
      this.lastMessageAt = Date.now()
      if (message.type === 'device:heartbeat') {
        if (message.payload.connectionId !== this.connectionId) throw new Error('Wrong connection')
      } else if (message.type === 'device:disconnect') {
        if (message.payload.connectionId !== this.connectionId) throw new Error('Wrong connection')
        this.socket?.close(1000, 'Peer disconnected')
        this.reset()
      } else if (message.type === 'text:send') {
        const received = {
          messageId: message.messageId,
          peer: this.peer,
          content: message.payload.content,
          contentType: message.payload.contentType,
          receivedAt: Date.now(),
        }
        for (const listener of this.textListeners) listener(received)
        this.sendTextAcknowledgement(message.messageId)
      } else if (message.type === 'text:ack') {
        this.pendingTextAcknowledgements.get(message.payload.messageId)?.complete(true)
      } else if (
        message.type === 'folder:offer' ||
        message.type === 'folder:manifest' ||
        message.type === 'folder:accept' ||
        message.type === 'folder:reject' ||
        message.type === 'folder:cancel' ||
        message.type === 'folder:progress' ||
        message.type === 'folder:complete' ||
        message.type === 'folder:error'
      ) {
        for (const listener of this.folderMessageListeners) listener(message)
      } else {
        for (const listener of this.fileMessageListeners) listener(message)
      }
    } catch {
      this.socket?.close(1007, 'Invalid protocol message')
      this.reset('PROTOCOL_INVALID')
    }
  }

  private handlePeerPairingDecision(message: PairingDecisionMessage): void {
    const context = this.secureContext
    if (
      context === null ||
      message.senderId !== context.peer.deviceId ||
      message.payload.connectionId !== context.connectionId ||
      message.payload.requestId !== context.pairingRequestId ||
      !isMessageTimestampAllowed(message.timestamp) ||
      this.messageDeduplicator.isDuplicate(message.messageId)
    ) {
      throw new Error('Invalid pairing decision')
    }
    this.lastMessageAt = Date.now()
    if (message.payload.decision === 'reject') {
      context.socket.close(1008, 'Pairing rejected')
      this.reset('PAIRING_REJECTED')
      return
    }
    if (context.localTrusted) {
      this.activateSecureContext()
      return
    }
    if (!this.pairingCoordinator.confirmPeer(context.pairingRequestId, 'accept')) {
      throw new Error('Pairing decision has no pending request')
    }
  }

  private handlePairingCompletion(completion: PairingCompletion): void {
    const context = this.secureContext
    if (context === null || completion.requestId !== context.pairingRequestId) return
    if (completion.outcome === 'paired') {
      this.activateSecureContext()
      return
    }
    context.socket.close(1008, 'Pairing did not complete')
    this.reset(completion.errorCode ?? 'PAIRING_REJECTED')
  }

  private sendPairingDecision(decision: 'accept' | 'reject'): void {
    const context = this.secureContext
    if (context === null) return
    const localDevice = this.getLocalDevice()
    const message = pairingDecisionMessageSchema.parse({
      type: 'pairing:decision',
      messageId: createMessageId(),
      senderId: localDevice.deviceId,
      timestamp: Date.now(),
      payload: {
        requestId: context.pairingRequestId,
        connectionId: context.connectionId,
        decision,
      },
    })
    this.sendEncryptedMessage(message, (error) => {
      if (error) this.reset('CONNECTION_CLOSED')
    })
  }

  private runHeartbeat(): void {
    if (this.socket === null || this.connectionId === null || this.peer === null) return
    if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
      this.socket.terminate()
      this.reset('CONNECTION_TIMEOUT')
      return
    }
    const localDevice = this.getLocalDevice()
    this.heartbeatSequence += 1
    this.sendEncryptedMessage(
      deviceHeartbeatMessageSchema.parse({
        type: 'device:heartbeat',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { connectionId: this.connectionId, sequence: this.heartbeatSequence },
      }),
    )
  }

  private sendTextAcknowledgement(messageId: MessageId): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return
    const localDevice = this.getLocalDevice()
    this.sendEncryptedMessage(
      textAcknowledgementMessageSchema.parse({
        type: 'text:ack',
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload: { messageId },
      }),
    )
  }

  private sendFolderMessage<
    TMessage extends FolderControlMessage,
    TSchema extends { parse(input: unknown): TMessage },
  >(type: TMessage['type'], schema: TSchema, payload: TMessage['payload']): Promise<boolean> {
    const localDevice = this.getLocalDevice()
    return this.sendProtocolMessage(
      schema.parse({
        type,
        messageId: createMessageId(),
        senderId: localDevice.deviceId,
        timestamp: Date.now(),
        payload,
      }),
    )
  }

  private async sendProtocolMessage(
    message: FileControlMessage | FolderControlMessage,
  ): Promise<boolean> {
    const socket = this.socket
    if (
      socket === null ||
      this.status.state !== 'connected' ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return false
    }
    return new Promise((resolve) => {
      this.sendEncryptedMessage(message, (error) => resolve(!error))
    })
  }

  private sendEncryptedMessage(
    message: unknown,
    callback: (error?: Error) => void = () => undefined,
  ): void {
    const context = this.secureContext
    const socket = this.socket
    if (context === null || socket === null || socket.readyState !== WebSocket.OPEN) {
      callback(new Error('Secure connection is not open'))
      return
    }
    try {
      socket.send(JSON.stringify(context.cipher.encrypt(message)), callback)
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Secure message encryption failed'))
    }
  }

  private reset(errorCode?: ErrorCode): void {
    const secureContext = this.secureContext
    this.secureContext = null
    secureContext?.cipher.destroy()
    this.fileRootKey?.fill(0)
    this.fileRootKey = null
    this.pairingCoordinator.cancel(errorCode ?? 'CONNECTION_CLOSED')
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    if (this.pendingConnection !== null) clearTimeout(this.pendingConnection.timeout)
    for (const acknowledgement of this.pendingTextAcknowledgements.values()) {
      acknowledgement.complete(false)
    }
    this.pendingTextAcknowledgements.clear()
    this.incomingMessageRateLimiter.clear()
    this.handshakeTimer = null
    this.heartbeatTimer = null
    this.pendingConnection = null
    this.socket = null
    this.connectionId = null
    this.peer = null
    this.setStatus({ state: 'disconnected', ...(errorCode === undefined ? {} : { errorCode }) })
    secureContext?.settle?.()
  }

  private setStatus(status: ConnectionStatusDto): void {
    this.status = status
    const snapshot = this.getStatus()
    for (const listener of this.statusListeners) listener(snapshot)
  }
}
