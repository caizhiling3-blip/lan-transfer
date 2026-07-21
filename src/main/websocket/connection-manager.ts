import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import WebSocket from 'ws'
import type { RawData } from 'ws'

import {
  CONNECTION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from '@shared/constants'
import type { ErrorCode } from '@shared/errors'
import {
  deviceDisconnectMessageSchema,
  deviceHeartbeatMessageSchema,
  deviceHelloMessageSchema,
  deviceWelcomeMessageSchema,
  parseProtocolMessage,
  textSendMessageSchema,
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
  IncomingConnectionRequestDto,
  RequestId,
  TransferTaskDto,
} from '@shared/types'
import type { TextReceivedDto } from '@shared/ipc'

type StatusListener = (status: ConnectionStatusDto) => void
type RequestListener = (request: IncomingConnectionRequestDto) => void
type TextListener = (message: TextReceivedDto) => void

interface PendingConnection {
  readonly requestId: RequestId
  readonly socket: WebSocket
  readonly peer: DeviceInfo
  readonly timeout: ReturnType<typeof setTimeout>
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private connectionId: ConnectionId | null = null
  private peer: DeviceInfo | null = null
  private heartbeatSequence = 0
  private lastMessageAt = 0

  public constructor(private readonly getLocalDevice: () => DeviceInfo) {}

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

  public async sendText(
    content: string,
    contentType: 'text' | 'link',
  ): Promise<TransferTaskDto | null> {
    const socket = this.socket
    const peer = this.peer
    if (socket === null || peer === null || socket.readyState !== WebSocket.OPEN) return null

    const localDevice = this.getLocalDevice()
    const now = Date.now()
    const message = textSendMessageSchema.parse({
      type: 'text:send',
      messageId: createMessageId(),
      senderId: localDevice.deviceId,
      timestamp: now,
      payload: { content, contentType },
    })
    const succeeded = await new Promise<boolean>((resolve) => {
      socket.send(JSON.stringify(message), (error) => resolve(!error))
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

    socket.once('message', (data) => {
      try {
        const message = parseProtocolMessage(JSON.parse(data.toString()))
        if (message.type !== 'device:hello') throw new Error('Expected device hello')
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
        this.pendingConnection = { requestId, socket, peer, timeout: approvalTimeout }
        this.setStatus({ state: 'awaitingApproval', peer })
        const incomingRequest = { requestId, peer, receivedAt: Date.now() }
        for (const listener of this.requestListeners) listener(incomingRequest)
      } catch {
        socket.close(1007, 'Invalid protocol message')
        this.reset('PROTOCOL_INVALID')
      }
    })
    socket.once('error', (error) => this.reset(mapConnectionError(error)))
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
        const hello = deviceHelloMessageSchema.parse({
          type: 'device:hello',
          messageId: createMessageId(),
          senderId: localDevice.deviceId,
          timestamp: Date.now(),
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            device: localDevice,
            connectionNonce: randomBytes(24).toString('base64url'),
          },
        })
        socket.send(JSON.stringify(hello))
      })

      socket.once('message', (data) => {
        try {
          const message = parseProtocolMessage(JSON.parse(data.toString()))
          if (message.type !== 'device:welcome') throw new Error('Expected device welcome')
          clearTimeout(timeout)
          this.handshakeTimer = null
          this.activate(
            socket,
            { ...message.payload.device, ipAddress: host },
            message.payload.connectionId,
          )
          settle()
        } catch {
          socket.close(1007, 'Invalid protocol message')
          this.reset('PROTOCOL_INVALID')
          settle()
        }
      })
      socket.once('error', (error) => {
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
    const welcome = deviceWelcomeMessageSchema.parse({
      type: 'device:welcome',
      messageId: createMessageId(),
      senderId: localDevice.deviceId,
      timestamp: Date.now(),
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        device: localDevice,
        connectionId,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      },
    })
    pending.socket.send(JSON.stringify(welcome))
    this.activate(pending.socket, pending.peer, connectionId)
    return this.getStatus()
  }

  public disconnect(reason: 'user_requested' | 'app_shutdown' = 'user_requested'): void {
    const socket = this.socket
    if (socket === null) return
    this.setStatus({ state: 'disconnecting', ...(this.peer === null ? {} : { peer: this.peer }) })
    if (socket.readyState === WebSocket.OPEN && this.connectionId !== null) {
      const localDevice = this.getLocalDevice()
      socket.send(
        JSON.stringify(
          deviceDisconnectMessageSchema.parse({
            type: 'device:disconnect',
            messageId: createMessageId(),
            senderId: localDevice.deviceId,
            timestamp: Date.now(),
            payload: { connectionId: this.connectionId, reason },
          }),
        ),
      )
      socket.close(1000, 'Disconnected')
    } else {
      socket.terminate()
    }
    this.reset()
  }

  private activate(socket: WebSocket, peer: DeviceInfo, connectionId: ConnectionId): void {
    socket.removeAllListeners()
    this.socket = socket
    this.peer = peer
    this.connectionId = connectionId
    this.lastMessageAt = Date.now()
    this.heartbeatSequence = 0
    this.setStatus({ state: 'connected', connectionId, peer })

    socket.on('message', (data) => this.handleConnectedMessage(data))
    socket.once('error', (error) => this.reset(mapConnectionError(error)))
    socket.once('close', () => this.reset())
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS)
  }

  private handleConnectedMessage(data: RawData): void {
    try {
      const message = parseProtocolMessage(JSON.parse(data.toString()))
      if (this.peer === null || message.senderId !== this.peer.deviceId) {
        throw new Error('Unexpected message sender')
      }
      this.lastMessageAt = Date.now()
      if (message.type === 'device:heartbeat') {
        if (message.payload.connectionId !== this.connectionId) throw new Error('Wrong connection')
      } else if (message.type === 'device:disconnect') {
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
      }
    } catch {
      this.socket?.close(1007, 'Invalid protocol message')
      this.reset('PROTOCOL_INVALID')
    }
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
    this.socket.send(
      JSON.stringify(
        deviceHeartbeatMessageSchema.parse({
          type: 'device:heartbeat',
          messageId: createMessageId(),
          senderId: localDevice.deviceId,
          timestamp: Date.now(),
          payload: { connectionId: this.connectionId, sequence: this.heartbeatSequence },
        }),
      ),
    )
  }

  private reset(errorCode?: ErrorCode): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    if (this.pendingConnection !== null) clearTimeout(this.pendingConnection.timeout)
    this.handshakeTimer = null
    this.heartbeatTimer = null
    this.pendingConnection = null
    this.socket = null
    this.connectionId = null
    this.peer = null
    this.setStatus({ state: 'disconnected', ...(errorCode === undefined ? {} : { errorCode }) })
  }

  private setStatus(status: ConnectionStatusDto): void {
    this.status = status
    const snapshot = this.getStatus()
    for (const listener of this.statusListeners) listener(snapshot)
  }
}
