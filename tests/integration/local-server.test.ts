import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalServer } from '../../src/main/server/local-server'
import { ServiceManager } from '../../src/main/server/service-manager'
import { PROTOCOL_VERSION } from '@shared/constants'

const runningServers: LocalServer[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()))
})

describe('LocalServer', () => {
  it('serves only the health endpoint', async () => {
    const server = new LocalServer()
    runningServers.push(server)
    const port = await server.start(0, '127.0.0.1')

    const healthResponse = await fetch(`http://127.0.0.1:${String(port)}/health`)
    expect(healthResponse.status).toBe(200)
    expect(healthResponse.headers.get('cache-control')).toBe('no-store')
    await expect(healthResponse.json()).resolves.toEqual({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
    })

    const unknownResponse = await fetch(`http://127.0.0.1:${String(port)}/unknown`)
    expect(unknownResponse.status).toBe(404)
    await expect(unknownResponse.json()).resolves.toEqual({ error: 'NOT_FOUND' })
  })

  it('accepts only the WebSocket path and closes without a connection handler', async () => {
    const server = new LocalServer()
    runningServers.push(server)
    const port = await server.start(0, '127.0.0.1')

    const webSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/ws`)
    const closeResult = await new Promise<{ readonly code: number; readonly reason: string }>(
      (resolve, reject) => {
        webSocket.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
        webSocket.once('error', reject)
      },
    )
    expect(closeResult).toEqual({
      code: 1013,
      reason: 'Device connection handler is unavailable',
    })

    const invalidStatus = await new Promise<number>((resolve, reject) => {
      const invalidWebSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/invalid`)
      invalidWebSocket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      invalidWebSocket.once('error', reject)
    })
    expect(invalidStatus).toBe(404)

    const forbiddenOriginStatus = await new Promise<number>((resolve, reject) => {
      const browserLikeWebSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/ws`, {
        origin: 'https://untrusted.example',
      })
      browserLikeWebSocket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      browserLikeWebSocket.once('error', reject)
    })
    expect(forbiddenOriginStatus).toBe(403)
  })

  it('releases the port when stopped', async () => {
    const server = new LocalServer()
    const port = await server.start(0, '127.0.0.1')
    await server.stop()

    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow()
  })

  it('rate limits repeated HTTP requests from one source', async () => {
    const server = new LocalServer({ httpRequestsPerWindow: 2, rateLimitWindowMs: 60_000 })
    runningServers.push(server)
    const port = await server.start(0, '127.0.0.1')

    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200)
    const limited = await fetch(`http://127.0.0.1:${String(port)}/health`)
    expect(limited.status).toBe(429)
    await expect(limited.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
  })

  it('uses an independent bounded rate limit for transfer upload routes', async () => {
    const server = new LocalServer({
      httpRequestsPerWindow: 1,
      transferHttpRequestsPerWindow: 2,
      rateLimitWindowMs: 60_000,
    })
    runningServers.push(server)
    const port = await server.start(0, '127.0.0.1')
    const uploadUrl = `http://127.0.0.1:${String(port)}/v3/transfers/transfer/files/file/chunks/0`

    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200)
    expect((await fetch(uploadUrl, { method: 'PUT' })).status).toBe(404)
    expect((await fetch(uploadUrl, { method: 'PUT' })).status).toBe(404)
    expect((await fetch(uploadUrl, { method: 'PUT' })).status).toBe(429)
    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(429)
  })

  it('rate limits repeated WebSocket upgrades from one source', async () => {
    const server = new LocalServer({
      rateLimitWindowMs: 60_000,
      webSocketUpgradesPerWindow: 1,
    })
    runningServers.push(server)
    const port = await server.start(0, '127.0.0.1')

    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/ws`)
    await expect(
      new Promise<number>((resolve, reject) => {
        first.once('close', resolve)
        first.once('error', reject)
      }),
    ).resolves.toBe(1013)

    const limitedStatus = await new Promise<number>((resolve, reject) => {
      const limited = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/ws`)
      limited.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      limited.once('error', reject)
    })
    expect(limitedStatus).toBe(429)
  })
})

describe('ServiceManager', () => {
  it('maps an occupied port and emits state changes', async () => {
    const occupiedServer = createHttpServer()
    await new Promise<void>((resolve) => {
      occupiedServer.listen(0, '127.0.0.1', resolve)
    })
    const address = occupiedServer.address() as AddressInfo
    const manager = new ServiceManager(
      address.port,
      () => new LocalServer(),
      () => ['192.168.1.20'],
      '127.0.0.1',
    )
    const states: string[] = []
    manager.subscribe((status) => states.push(status.state))

    const status = await manager.start()

    expect(status).toEqual({
      state: 'error',
      ipAddresses: ['192.168.1.20'],
      port: address.port,
      errorCode: 'PORT_IN_USE',
    })
    expect(states).toEqual(['starting', 'error'])

    await new Promise<void>((resolve, reject) => {
      occupiedServer.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('restarts on a new port and stops the previous server', async () => {
    const calls: string[] = []
    let nextPort = 40_000
    const manager = new ServiceManager(53_317, () => ({
      start: async () => {
        calls.push('start')
        nextPort += 1
        return nextPort
      },
      stop: async () => {
        calls.push('stop')
      },
    }))

    expect((await manager.start()).port).toBe(40_001)
    expect((await manager.restart(54_000)).port).toBe(40_002)
    expect(calls).toEqual(['start', 'stop', 'start'])
    expect((await manager.stop()).state).toBe('stopped')
  })

  it('serializes overlapping lifecycle operations', async () => {
    let activeStarts = 0
    let maximumActiveStarts = 0
    let stopCalls = 0
    const manager = new ServiceManager(53_317, () => ({
      start: async (port) => {
        activeStarts += 1
        maximumActiveStarts = Math.max(maximumActiveStarts, activeStarts)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeStarts -= 1
        return port
      },
      stop: async () => {
        stopCalls += 1
      },
    }))

    const initialStart = manager.start()
    const restart = manager.restart(54_000)
    await Promise.all([initialStart, restart])

    expect(maximumActiveStarts).toBe(1)
    expect(stopCalls).toBe(1)
    expect(manager.getStatus()).toMatchObject({ state: 'running', port: 54_000 })
    await manager.stop()
  })

  it('moves to an error state after a runtime server failure', async () => {
    let runtimeErrorHandler: ((error: Error) => void) | undefined
    const manager = new ServiceManager(
      53_317,
      () => ({
        start: async () => 53_317,
        stop: async () => undefined,
        setErrorHandler: (handler) => {
          runtimeErrorHandler = handler
        },
      }),
      () => [],
    )

    await manager.start()
    runtimeErrorHandler?.(Object.assign(new Error('network down'), { code: 'ENETDOWN' }))

    await expect
      .poll(() => manager.getStatus())
      .toEqual({
        state: 'error',
        ipAddresses: [],
        port: 53_317,
        errorCode: 'NETWORK_UNREACHABLE',
      })
  })
})
