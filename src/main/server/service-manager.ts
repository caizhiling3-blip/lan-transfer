import type { ErrorCode } from '@shared/errors'
import type { ServiceStatusDto } from '@shared/types'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'

import { LocalServer } from './local-server'
import { getLanIpv4Addresses } from './network-info'

export interface LocalServerAdapter {
  start(port: number, host?: string): Promise<number>
  stop(): Promise<void>
  setErrorHandler?(handler: (error: Error) => void): void
  setConnectionHandler?(handler: WebSocketConnectionHandler): void
}

export type ServiceStatusListener = (status: ServiceStatusDto) => void
export type WebSocketConnectionHandler = (webSocket: WebSocket, request: IncomingMessage) => void

const mapStartError = (error: unknown): ErrorCode => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EADDRINUSE'
  ) {
    return 'PORT_IN_USE'
  }
  return 'NETWORK_UNREACHABLE'
}

export class ServiceManager {
  private server: LocalServerAdapter | null = null
  private status: ServiceStatusDto
  private readonly listeners = new Set<ServiceStatusListener>()
  private connectionHandler: WebSocketConnectionHandler | null = null
  private lifecycleQueue: Promise<void> = Promise.resolve()

  public constructor(
    initialPort: number,
    private readonly createServer: () => LocalServerAdapter = () => new LocalServer(),
    private readonly getIpAddresses: () => readonly string[] = getLanIpv4Addresses,
    private readonly host = '0.0.0.0',
  ) {
    this.status = {
      state: 'stopped',
      ipAddresses: this.getIpAddresses(),
      port: initialPort,
    }
  }

  public getStatus(): ServiceStatusDto {
    return { ...this.status, ipAddresses: [...this.status.ipAddresses] }
  }

  public subscribe(listener: ServiceStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public setConnectionHandler(handler: WebSocketConnectionHandler): void {
    this.connectionHandler = handler
    this.server?.setConnectionHandler?.(handler)
  }

  public async start(port = this.status.port): Promise<ServiceStatusDto> {
    return this.enqueueLifecycle(() => this.startInternal(port))
  }

  public async restart(port: number): Promise<ServiceStatusDto> {
    return this.enqueueLifecycle(async () => {
      await this.stopInternal()
      return this.startInternal(port)
    })
  }

  public async stop(): Promise<ServiceStatusDto> {
    return this.enqueueLifecycle(() => this.stopInternal())
  }

  private async startInternal(port: number): Promise<ServiceStatusDto> {
    if (this.server !== null) {
      await this.stopInternal()
    }

    this.setStatus({ state: 'starting', ipAddresses: this.getIpAddresses(), port })
    const server = this.createServer()
    if (this.connectionHandler !== null) {
      server.setConnectionHandler?.(this.connectionHandler)
    }
    server.setErrorHandler?.((error) => {
      void this.enqueueLifecycle(async () => {
        if (this.server !== server) {
          return
        }
        this.server = null
        await server.stop().catch(() => undefined)
        this.setStatus({
          state: 'error',
          ipAddresses: this.getIpAddresses(),
          port: this.status.port,
          errorCode: mapStartError(error),
        })
      })
    })

    try {
      const actualPort = await server.start(port, this.host)
      this.server = server
      this.setStatus({
        state: 'running',
        ipAddresses: this.getIpAddresses(),
        port: actualPort,
      })
    } catch (error) {
      await server.stop().catch(() => undefined)
      this.setStatus({
        state: 'error',
        ipAddresses: this.getIpAddresses(),
        port,
        errorCode: mapStartError(error),
      })
    }

    return this.getStatus()
  }

  private async stopInternal(): Promise<ServiceStatusDto> {
    const server = this.server
    this.server = null
    if (server !== null) {
      await server.stop()
    }
    this.setStatus({
      state: 'stopped',
      ipAddresses: this.getIpAddresses(),
      port: this.status.port,
    })
    return this.getStatus()
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private setStatus(status: ServiceStatusDto): void {
    this.status = status
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
