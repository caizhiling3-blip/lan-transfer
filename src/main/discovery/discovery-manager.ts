import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import type { RemoteInfo, Socket } from 'node:dgram'

import {
  DISCOVERY_ANNOUNCEMENT_INTERVAL_MS,
  DISCOVERY_APP_ID,
  DISCOVERY_MULTICAST_ADDRESS,
  DISCOVERY_PORT,
  MAX_DISCOVERY_DATAGRAM_BYTES,
  PROTOCOL_VERSION,
} from '@shared/constants'
import { discoveryAnnouncementSchema } from '@shared/protocols'
import { messageIdSchema } from '@shared/types'
import type { DeviceInfo, DiscoveredDeviceDto } from '@shared/types'

import { DiscoveryRegistry } from './discovery-registry'

type DiscoveryListener = (devices: readonly DiscoveredDeviceDto[]) => void
type ErrorListener = (error: unknown) => void

export class DiscoveryManager {
  private readonly registry: DiscoveryRegistry
  private readonly listeners = new Set<DiscoveryListener>()
  private socket: Socket | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null

  public constructor(
    private readonly getLocalDevice: () => DeviceInfo,
    private readonly onError: ErrorListener = () => undefined,
  ) {
    this.registry = new DiscoveryRegistry(getLocalDevice().deviceId)
  }

  public start(): void {
    if (this.socket !== null) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (message, remoteInfo) => this.handleMessage(message, remoteInfo))
    socket.on('error', (error) => this.onError(error))
    socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      if (this.socket !== socket) return
      try {
        socket.addMembership(DISCOVERY_MULTICAST_ADDRESS)
        socket.setMulticastTTL(1)
        socket.setMulticastLoopback(true)
        socket.unref()
        this.announce()
        this.announceTimer = setInterval(() => this.announce(), DISCOVERY_ANNOUNCEMENT_INTERVAL_MS)
        this.announceTimer.unref()
      } catch (error) {
        this.onError(error)
      }
    })
    this.expiryTimer = setInterval(() => {
      if (this.registry.removeExpired()) this.emitDevices()
    }, DISCOVERY_ANNOUNCEMENT_INTERVAL_MS)
    this.expiryTimer.unref()
  }

  public stop(): void {
    if (this.announceTimer !== null) clearInterval(this.announceTimer)
    if (this.expiryTimer !== null) clearInterval(this.expiryTimer)
    this.announceTimer = null
    this.expiryTimer = null
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close()
      } catch (error) {
        this.onError(error)
      }
    }
  }

  public getDevices(): readonly DiscoveredDeviceDto[] {
    this.registry.removeExpired()
    return this.registry.list()
  }

  public subscribe(listener: DiscoveryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private announce(): void {
    const socket = this.socket
    if (socket === null) return
    const localDevice = this.getLocalDevice()
    const announcement = discoveryAnnouncementSchema.parse({
      appId: DISCOVERY_APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      messageId: messageIdSchema.parse(randomUUID()),
      deviceId: localDevice.deviceId,
      deviceName: localDevice.deviceName,
      operatingSystem: localDevice.operatingSystem,
      servicePort: localDevice.servicePort,
      timestamp: Date.now(),
    })
    const data = Buffer.from(JSON.stringify(announcement), 'utf8')
    socket.send(data, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (error) => {
      if (error !== null) this.onError(error)
    })
  }

  private handleMessage(message: Buffer, remoteInfo: RemoteInfo): void {
    if (message.byteLength > MAX_DISCOVERY_DATAGRAM_BYTES) return
    try {
      const parsed: unknown = JSON.parse(message.toString('utf8'))
      const changed = this.registry.accept(parsed, remoteInfo.address)
      if (changed) this.emitDevices()
    } catch {
      // Malformed discovery traffic is ignored without reflecting details to the sender.
    }
  }

  private emitDevices(): void {
    const devices = this.registry.list()
    for (const listener of this.listeners) listener(devices)
  }
}
