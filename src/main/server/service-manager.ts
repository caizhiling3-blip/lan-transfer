import type { ErrorCode } from '@shared/errors'
import type { ServiceStatusDto } from '@shared/types'

import { LocalServer } from './local-server'
import { getLanIpv4Addresses } from './network-info'

export interface LocalServerAdapter {
  start(port: number, host?: string): Promise<number>
  stop(): Promise<void>
  setErrorHandler?(handler: (error: Error) => void): void
}

export type ServiceStatusListener = (status: ServiceStatusDto) => void

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

  public async start(port = this.status.port): Promise<ServiceStatusDto> {
    if (this.server !== null) {
      await this.stop()
    }

    this.setStatus({ state: 'starting', ipAddresses: this.getIpAddresses(), port })
    const server = this.createServer()
    server.setErrorHandler?.((error) => {
      if (this.server !== server) {
        return
      }
      this.server = null
      void server.stop().catch(() => undefined)
      this.setStatus({
        state: 'error',
        ipAddresses: this.getIpAddresses(),
        port: this.status.port,
        errorCode: mapStartError(error),
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

  public async restart(port: number): Promise<ServiceStatusDto> {
    await this.stop()
    return this.start(port)
  }

  public async stop(): Promise<ServiceStatusDto> {
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

  private setStatus(status: ServiceStatusDto): void {
    this.status = status
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
