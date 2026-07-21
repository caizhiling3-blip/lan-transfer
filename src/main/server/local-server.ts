import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import { MAX_WEBSOCKET_MESSAGE_BYTES, PROTOCOL_VERSION } from '@shared/constants'

const HEALTH_PATH = '/health'
const WEBSOCKET_PATH = '/v1/ws'

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  const content = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Length': Buffer.byteLength(content),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(content)
}

const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  if (request.method === 'GET' && request.url === HEALTH_PATH) {
    writeJson(response, 200, { status: 'ok', protocolVersion: PROTOCOL_VERSION })
    return
  }

  writeJson(response, 404, { error: 'NOT_FOUND' })
}

const rejectUpgrade = (socket: Duplex, statusCode: number, statusText: string): void => {
  socket.end(
    `HTTP/1.1 ${String(statusCode)} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
}

export class LocalServer {
  private httpServer: Server | null = null
  private webSocketServer: WebSocketServer | null = null
  private errorHandler: (error: Error) => void = () => undefined
  private connectionHandler: (webSocket: WebSocket, request: IncomingMessage) => void = (
    webSocket,
  ) => {
    webSocket.close(1013, 'Device connection handler is unavailable')
  }

  public setErrorHandler(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  public setConnectionHandler(
    handler: (webSocket: WebSocket, request: IncomingMessage) => void,
  ): void {
    this.connectionHandler = handler
  }

  public async start(port: number, host = '0.0.0.0'): Promise<number> {
    if (this.httpServer !== null) {
      throw new Error('Local server is already running')
    }

    const httpServer = createServer(handleRequest)
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      perMessageDeflate: false,
    })

    httpServer.headersTimeout = 5_000
    httpServer.requestTimeout = 10_000
    httpServer.keepAliveTimeout = 1_000
    httpServer.maxHeadersCount = 50

    httpServer.on('upgrade', (request, socket, head) => {
      let url: URL
      try {
        url = new URL(request.url ?? '', 'http://localhost')
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request')
        return
      }

      if (url.pathname !== WEBSOCKET_PATH || url.search !== '') {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }

      if (request.headers.origin !== undefined) {
        rejectUpgrade(socket, 403, 'Forbidden')
        return
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })

    webSocketServer.on('connection', (webSocket, request) => {
      this.connectionHandler(webSocket, request)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error): void => {
          reject(error)
        }
        httpServer.once('error', handleError)
        httpServer.listen(port, host, () => {
          httpServer.off('error', handleError)
          resolve()
        })
      })
    } catch (error) {
      webSocketServer.close()
      throw error
    }

    this.httpServer = httpServer
    this.webSocketServer = webSocketServer
    httpServer.on('error', (error) => this.errorHandler(error))

    const address = httpServer.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('Local server did not expose a TCP port')
    }

    return address.port
  }

  public async stop(): Promise<void> {
    const httpServer = this.httpServer
    const webSocketServer = this.webSocketServer
    this.httpServer = null
    this.webSocketServer = null

    if (httpServer === null || webSocketServer === null) {
      return
    }

    for (const client of webSocketServer.clients) {
      client.terminate()
    }
    webSocketServer.close()

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }
}
