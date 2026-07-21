import WebSocket from 'ws'
import type { RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalServer } from '../../src/main/server/local-server'
import { ConnectionManager } from '../../src/main/websocket/connection-manager'
import type { TextReceivedDto } from '@shared/ipc'
import { parseProtocolMessage } from '@shared/protocols'
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

const createPair = async () => {
  const server = new LocalServer()
  servers.push(server)
  let serverPort = 0
  const receiver = new ConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', serverPort),
  )
  const sender = new ConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(sender, receiver)
  server.setConnectionHandler((socket, request) => receiver.acceptIncoming(socket, request))
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

  it('does not project a duplicate text message but acknowledges it again', async () => {
    const { receiver, serverPort } = await createPair()
    const requestPromise = waitForRequest(receiver)
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    const rawDevice = createDevice('66666666-6666-4666-8666-666666666666', 'Raw sender', 54_000)
    socket.send(
      JSON.stringify({
        type: 'device:hello',
        messageId: '77777777-7777-4777-8777-777777777777',
        senderId: rawDevice.deviceId,
        timestamp: Date.now(),
        payload: { protocolVersion: 1, device: rawDevice, connectionNonce: 'n'.repeat(32) },
      }),
    )
    const request = await requestPromise
    const welcomePromise = new Promise<void>((resolve, reject) => {
      const handleMessage = (data: RawData): void => {
        const message = parseProtocolMessage(JSON.parse(data.toString()))
        if (message.type !== 'device:welcome') return
        socket.off('message', handleMessage)
        resolve()
      }
      socket.on('message', handleMessage)
      socket.once('error', reject)
    })
    receiver.respondToRequest(request.requestId, 'accept')
    await welcomePromise

    let receivedCount = 0
    const unsubscribe = receiver.subscribeText(() => {
      receivedCount += 1
    })
    const acknowledgementPromise = new Promise<void>((resolve, reject) => {
      let acknowledgementCount = 0
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for acknowledgements')),
        1_000,
      )
      const handleMessage = (data: RawData): void => {
        const message = parseProtocolMessage(JSON.parse(data.toString()))
        if (message.type !== 'text:ack') return
        acknowledgementCount += 1
        if (acknowledgementCount === 2) {
          clearTimeout(timeout)
          socket.off('message', handleMessage)
          resolve()
        }
      }
      socket.on('message', handleMessage)
      socket.once('error', reject)
    })
    const textMessage = JSON.stringify({
      type: 'text:send',
      messageId: '88888888-8888-4888-8888-888888888888',
      senderId: rawDevice.deviceId,
      timestamp: Date.now(),
      payload: { content: 'send once', contentType: 'text' },
    })
    socket.send(textMessage)
    socket.send(textMessage)

    await acknowledgementPromise
    unsubscribe()
    expect(receivedCount).toBe(1)
    socket.close()
  })

  it('does not create a text task without an active connection', async () => {
    const sender = new ConnectionManager(() =>
      createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
    )
    managers.push(sender)

    await expect(sender.sendText('not connected', 'text')).resolves.toBeNull()
  })

  it('maps a closed target port to a connection error', async () => {
    const temporaryServer = new LocalServer()
    const port = await temporaryServer.start(0, '127.0.0.1')
    await temporaryServer.stop()
    const sender = new ConnectionManager(() =>
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

  it('rejects a hello whose envelope sender does not match the advertised device', async () => {
    const { receiver, serverPort } = await createPair()
    const socket = new WebSocket(`ws://127.0.0.1:${String(serverPort)}/v1/ws`)
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'device:hello',
          messageId: '33333333-3333-4333-8333-333333333333',
          senderId: '44444444-4444-4444-8444-444444444444',
          timestamp: Date.now(),
          payload: {
            protocolVersion: 1,
            device: createDevice('55555555-5555-4555-8555-555555555555', 'Spoofed', 54_000),
            connectionNonce: 'n'.repeat(32),
          },
        }),
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
          type: 'device:hello',
          messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          senderId: device.deviceId,
          timestamp: Date.now() - 6 * 60_000,
          payload: { protocolVersion: 1, device, connectionNonce: 'n'.repeat(32) },
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
