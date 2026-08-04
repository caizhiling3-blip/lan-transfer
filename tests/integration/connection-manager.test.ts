import WebSocket from 'ws'
import type { RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalServer } from '../../src/main/server/local-server'
import { generateEphemeralKeyPair, generateHandshakeNonce } from '../../src/main/security'
import type { ConnectionManager } from '../../src/main/websocket/connection-manager'
import {
  createAutoPairingConnectionManager,
  createMemoryIdentitySigner,
  createSecureConnectionEndpoint,
} from '../helpers/secure-connection'
import { PROTOCOL_VERSION } from '@shared/constants'
import type { TextReceivedDto } from '@shared/ipc'
import { encryptedEnvelopeSchema, parseSecureHandshakeMessage } from '@shared/protocols'
import { deviceIdSchema } from '@shared/types'
import type { DeviceInfo, IncomingConnectionRequestDto } from '@shared/types'

const servers: LocalServer[] = []
const managers: ConnectionManager[] = []

const createDevice = (id: string, name: string, port: number): DeviceInfo => ({
  deviceId: deviceIdSchema.parse(id),
  deviceName: name,
  operatingSystem: 'macos',
  ipAddress: '127.0.0.1',
  servicePort: port,
})

const waitForRequest = (manager: ConnectionManager): Promise<IncomingConnectionRequestDto> =>
  new Promise((resolve) => {
    const unsubscribe = manager.subscribeRequests((request) => {
      unsubscribe()
      resolve(request)
    })
  })

const waitForText = (manager: ConnectionManager): Promise<TextReceivedDto> =>
  new Promise((resolve) => {
    const unsubscribe = manager.subscribeText((message) => {
      unsubscribe()
      resolve(message)
    })
  })

const createSecureHello = (
  device: DeviceInfo,
  senderId: string = device.deviceId,
  timestamp = Date.now(),
) => ({
  type: 'secure:hello',
  messageId: '33333333-3333-4333-8333-333333333333',
  senderId: deviceIdSchema.parse(senderId),
  timestamp,
  payload: {
    protocolVersion: PROTOCOL_VERSION,
    device,
    identity: createMemoryIdentitySigner().getPublicIdentity(),
    keyAgreement: 'X25519',
    ephemeralPublicKey: generateEphemeralKeyPair().publicKey,
    nonce: generateHandshakeNonce(),
  },
})

const createPair = async (onIncomingSocket?: (socket: WebSocket) => void) => {
  const server = new LocalServer()
  servers.push(server)
  let serverPort = 0
  const receiver = createAutoPairingConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', serverPort),
  )
  const sender = createAutoPairingConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(sender, receiver)
  server.setConnectionHandler((socket, request) => {
    onIncomingSocket?.(socket)
    receiver.acceptIncoming(socket, request)
  })
  serverPort = await server.start(0, '127.0.0.1')
  return { sender, receiver, serverPort }
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.disconnect()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('ConnectionManager', () => {
  it('connects after explicit approval and exchanges device information', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const incomingRequestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise

    expect(receiver.getStatus()).toMatchObject({
      state: 'awaitingApproval',
      peer: { deviceName: 'Sender' },
      pendingRequest: { requestId: incomingRequest.requestId, peer: { deviceName: 'Sender' } },
    })
    receiver.respondToRequest(incomingRequest.requestId, 'accept')

    await expect(connectionPromise).resolves.toMatchObject({
      state: 'connected',
      peer: { deviceName: 'Receiver', ipAddress: '127.0.0.1' },
    })
    expect(receiver.getStatus()).toMatchObject({
      state: 'connected',
      peer: { deviceName: 'Sender', ipAddress: '127.0.0.1' },
    })
  })

  it('rejects an incoming connection and returns both peers to disconnected', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const incomingRequestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise
    receiver.respondToRequest(incomingRequest.requestId, 'reject')

    await connectionPromise
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'CONNECTION_REFUSED',
    })
    expect(sender.getStatus().state).toBe('disconnected')
  })

  it('rejects a second socket while one peer is connected', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const incomingRequestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise
    receiver.respondToRequest(incomingRequest.requestId, 'accept')
    await connectionPromise

    const secondSocket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    const closeCode = await new Promise<number>((resolve, reject) => {
      secondSocket.once('close', resolve)
      secondSocket.once('error', reject)
    })

    expect(closeCode).toBe(1013)
    expect(sender.getStatus().state).toBe('connected')
    expect(receiver.getStatus().state).toBe('connected')
  })

  it('propagates an intentional disconnect to the peer', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const incomingRequestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise
    receiver.respondToRequest(incomingRequest.requestId, 'accept')
    await connectionPromise

    sender.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sender.getStatus().state).toBe('disconnected')
    expect(receiver.getStatus().state).toBe('disconnected')
  })

  it('sends text to the approved peer and reports a completed task', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const incomingRequestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise
    receiver.respondToRequest(incomingRequest.requestId, 'accept')
    await connectionPromise

    const receivedPromise = waitForText(receiver)
    const task = await sender.sendText('https://example.com/path', 'link')

    await expect(receivedPromise).resolves.toMatchObject({
      content: 'https://example.com/path',
      contentType: 'link',
      peer: { deviceName: 'Sender' },
    })
    expect(task).toMatchObject({
      direction: 'send',
      kind: 'link',
      status: 'completed',
      peer: { deviceName: 'Receiver' },
    })
  })

  it('requires both devices to confirm the same pairing code before connecting', async () => {
    const server = new LocalServer()
    servers.push(server)
    let serverPort = 0
    const receiverEndpoint = createSecureConnectionEndpoint(() =>
      createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', serverPort),
    )
    const senderEndpoint = createSecureConnectionEndpoint(() =>
      createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
    )
    managers.push(senderEndpoint.manager, receiverEndpoint.manager)
    server.setConnectionHandler((socket, request) =>
      receiverEndpoint.manager.acceptIncoming(socket, request),
    )
    serverPort = await server.start(0, '127.0.0.1')
    const incomingRequestPromise = waitForRequest(receiverEndpoint.manager)
    const senderPairingPromise = new Promise<
      ReturnType<typeof senderEndpoint.pairingCoordinator.getPending>
    >((resolve) => senderEndpoint.pairingCoordinator.subscribeRequests(resolve))
    const receiverPairingPromise = new Promise<
      ReturnType<typeof receiverEndpoint.pairingCoordinator.getPending>
    >((resolve) => receiverEndpoint.pairingCoordinator.subscribeRequests(resolve))
    const connectionPromise = senderEndpoint.manager.connect('127.0.0.1', serverPort)
    const incomingRequest = await incomingRequestPromise
    receiverEndpoint.manager.respondToRequest(incomingRequest.requestId, 'accept')
    const [senderPairing, receiverPairing] = await Promise.all([
      senderPairingPromise,
      receiverPairingPromise,
    ])
    if (senderPairing === null || receiverPairing === null)
      throw new Error('Pairing was not started')

    expect(senderPairing.requestId).toBe(receiverPairing.requestId)
    expect(senderPairing.verificationCode).toBe(receiverPairing.verificationCode)
    expect(senderEndpoint.manager.getStatus().state).toBe('pairingRequired')
    expect(receiverEndpoint.manager.getStatus().state).toBe('pairingRequired')
    senderEndpoint.pairingCoordinator.respond(senderPairing.requestId, 'accept')
    expect(senderEndpoint.manager.getStatus().state).not.toBe('connected')
    receiverEndpoint.pairingCoordinator.respond(receiverPairing.requestId, 'accept')

    await expect(connectionPromise).resolves.toMatchObject({ state: 'connected' })
    expect(receiverEndpoint.manager.getStatus().state).toBe('connected')
    expect(senderEndpoint.trustedDevices.get(senderPairing.peer.deviceId)).not.toBeNull()
    expect(receiverEndpoint.trustedDevices.get(receiverPairing.peer.deviceId)).not.toBeNull()

    senderEndpoint.manager.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 20))
    let repeatedPairingRequests = 0
    senderEndpoint.pairingCoordinator.subscribeRequests(() => {
      repeatedPairingRequests += 1
    })
    receiverEndpoint.pairingCoordinator.subscribeRequests(() => {
      repeatedPairingRequests += 1
    })
    const reconnectApprovalPromise = waitForRequest(receiverEndpoint.manager)
    const reconnectPromise = senderEndpoint.manager.connect('127.0.0.1', serverPort)
    receiverEndpoint.manager.respondToRequest((await reconnectApprovalPromise).requestId, 'accept')
    await expect(reconnectPromise).resolves.toMatchObject({ state: 'connected' })
    expect(repeatedPairingRequests).toBe(0)
  })

  it('sends connected control messages only inside encrypted envelopes', async () => {
    const incomingFrames: string[] = []
    const incomingSocketHolder: { socket: WebSocket | null } = { socket: null }
    const { sender, receiver, serverPort } = await createPair((socket) => {
      incomingSocketHolder.socket = socket
    })
    const requestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    receiver.respondToRequest((await requestPromise).requestId, 'accept')
    await connectionPromise
    const incomingSocket = incomingSocketHolder.socket
    if (incomingSocket === null) throw new Error('Server socket was not captured')
    incomingSocket.on('message', (data, isBinary) => {
      if (!isBinary) incomingFrames.push(data.toString())
    })

    await sender.sendText('never-visible-plaintext', 'text')

    expect(incomingFrames.length).toBeGreaterThan(0)
    expect(incomingFrames.join('')).not.toContain('never-visible-plaintext')
    expect(incomingFrames.join('')).not.toContain('text:send')
    expect(
      incomingFrames.some((frame) => encryptedEnvelopeSchema.safeParse(JSON.parse(frame)).success),
    ).toBe(true)
    const replayedFrame = incomingFrames.find(
      (frame) => encryptedEnvelopeSchema.safeParse(JSON.parse(frame)).success,
    )
    if (replayedFrame === undefined) throw new Error('Encrypted frame was not captured')
    incomingSocket.emit('message', Buffer.from(replayedFrame), false)
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'MESSAGE_REPLAYED',
    })
  })

  it('delivers consecutive encrypted text messages in sequence', async () => {
    const { sender, receiver, serverPort } = await createPair()
    const requestPromise = waitForRequest(receiver)
    const connectionPromise = sender.connect('127.0.0.1', serverPort)
    const request = await requestPromise
    receiver.respondToRequest(request.requestId, 'accept')
    await connectionPromise
    let receivedCount = 0
    const unsubscribe = receiver.subscribeText(() => {
      receivedCount += 1
    })
    await expect(sender.sendText('first', 'text')).resolves.toMatchObject({ status: 'completed' })
    await expect(sender.sendText('second', 'text')).resolves.toMatchObject({ status: 'completed' })
    unsubscribe()
    expect(receivedCount).toBe(2)
  })

  it('does not create a text task without an active connection', async () => {
    const sender = createAutoPairingConnectionManager(() =>
      createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
    )
    managers.push(sender)

    await expect(sender.sendText('not connected', 'text')).resolves.toBeNull()
  })

  it('maps a closed target port to a connection error', async () => {
    const temporaryServer = new LocalServer()
    const port = await temporaryServer.start(0, '127.0.0.1')
    await temporaryServer.stop()
    const sender = createAutoPairingConnectionManager(() =>
      createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
    )
    managers.push(sender)

    await sender.connect('127.0.0.1', port)

    expect(sender.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'CONNECTION_REFUSED',
    })
  })

  it('closes an inbound socket that sends invalid JSON', async () => {
    const { receiver, serverPort } = await createPair()
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    socket.once('open', () => socket.send('{invalid-json'))
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once('close', resolve)
      socket.once('error', reject)
    })

    expect(closeCode).toBe(1007)
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'PROTOCOL_INVALID',
    })
  })

  it('rejects a legacy plaintext handshake without protocol downgrade', async () => {
    const { receiver, serverPort } = await createPair()
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    const device = createDevice('66666666-6666-4666-8666-666666666666', 'Legacy', 54_000)
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'device:hello',
          messageId: '77777777-7777-4777-8777-777777777777',
          senderId: device.deviceId,
          timestamp: Date.now(),
          payload: { protocolVersion: 2, device, connectionNonce: 'n'.repeat(32) },
        }),
      )
    })

    await expect(
      new Promise<number>((resolve, reject) => {
        socket.once('close', resolve)
        socket.once('error', reject)
      }),
    ).resolves.toBe(1007)
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'PROTOCOL_INVALID',
    })
  })

  it('fails closed when the initiator proof signature is invalid', async () => {
    const { receiver, serverPort } = await createPair()
    const requestPromise = waitForRequest(receiver)
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    const device = createDevice('66666666-6666-4666-8666-666666666666', 'Forged', 54_000)
    const identitySigner = createMemoryIdentitySigner()
    const keys = generateEphemeralKeyPair()
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(
      JSON.stringify({
        type: 'secure:hello',
        messageId: '77777777-7777-4777-8777-777777777777',
        senderId: device.deviceId,
        timestamp: Date.now(),
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          device,
          identity: identitySigner.getPublicIdentity(),
          keyAgreement: 'X25519',
          ephemeralPublicKey: keys.publicKey,
          nonce: generateHandshakeNonce(),
        },
      }),
    )
    const request = await requestPromise
    const challengePromise = new Promise<ReturnType<typeof parseSecureHandshakeMessage>>(
      (resolve, reject) => {
        socket.once('message', (data: RawData) =>
          resolve(parseSecureHandshakeMessage(JSON.parse(data.toString()))),
        )
        socket.once('error', reject)
      },
    )
    receiver.respondToRequest(request.requestId, 'accept')
    const challenge = await challengePromise
    if (challenge.type !== 'secure:challenge') throw new Error('Expected challenge')
    socket.send(
      JSON.stringify({
        type: 'secure:proof',
        messageId: '88888888-8888-4888-8888-888888888888',
        senderId: device.deviceId,
        timestamp: Date.now(),
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          connectionId: challenge.payload.connectionId,
          signature: Buffer.alloc(64).toString('base64'),
        },
      }),
    )

    await expect(new Promise<number>((resolve) => socket.once('close', resolve))).resolves.toBe(
      1008,
    )
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'SIGNATURE_INVALID',
    })
  })

  it('rejects a hello whose envelope sender does not match the advertised device', async () => {
    const { receiver, serverPort } = await createPair()
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    socket.once('open', () => {
      socket.send(
        JSON.stringify(
          createSecureHello(
            createDevice('55555555-5555-4555-8555-555555555555', 'Spoofed', 54_000),
            '44444444-4444-4444-8444-444444444444',
          ),
        ),
      )
    })
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once('close', resolve)
      socket.once('error', reject)
    })

    expect(closeCode).toBe(1007)
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'PROTOCOL_INVALID',
    })
  })

  it('rejects stale and binary handshake messages', async () => {
    const { receiver, serverPort } = await createPair()
    const staleSocket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    staleSocket.once('open', () => {
      const device = createDevice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Stale sender', 54_000)
      staleSocket.send(
        JSON.stringify({
          ...createSecureHello(device, device.deviceId, Date.now() - 6 * 60_000),
          messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      )
    })
    await expect(
      new Promise<number>((resolve, reject) => {
        staleSocket.once('close', resolve)
        staleSocket.once('error', reject)
      }),
    ).resolves.toBe(1007)

    expect(receiver.getStatus().state).toBe('disconnected')
    const binarySocket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    binarySocket.once('open', () => binarySocket.send(Buffer.from('{}')))
    await expect(
      new Promise<number>((resolve, reject) => {
        binarySocket.once('close', resolve)
        binarySocket.once('error', reject)
      }),
    ).resolves.toBe(1007)
    expect(receiver.getStatus()).toMatchObject({
      state: 'disconnected',
      errorCode: 'PROTOCOL_INVALID',
    })
  })
})
