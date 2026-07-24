import { afterEach, describe, expect, it } from 'vitest'

import type { AuthorizedSourceFolder, FolderAccessAdapter } from '../../src/main/file-transfer'
import { FolderTransferCoordinator } from '../../src/main/file-transfer'
import { LocalServer } from '../../src/main/server/local-server'
import { ConnectionManager } from '../../src/main/websocket/connection-manager'
import type { FolderOfferReceivedDto } from '@shared/ipc'
import { deviceIdSchema, fileIdSchema } from '@shared/types'
import type { DeviceInfo, IncomingConnectionRequestDto, TransferTaskDto } from '@shared/types'

class TestFolderAccess implements FolderAccessAdapter {
  private readonly sources: Map<string, AuthorizedSourceFolder>

  public constructor(sources: readonly AuthorizedSourceFolder[]) {
    this.sources = new Map(sources.map((source) => [source.selection.selectionToken, source]))
  }

  public consumeFolder(selectionToken: string): AuthorizedSourceFolder | null {
    const source = this.sources.get(selectionToken) ?? null
    this.sources.delete(selectionToken)
    return source
  }

  public async resolveReceiveDirectory(): Promise<string> {
    return '/authorized-receive-directory'
  }
}

const servers: LocalServer[] = []
const managers: ConnectionManager[] = []
const coordinators: FolderTransferCoordinator[] = []

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

const waitForOffer = (coordinator: FolderTransferCoordinator): Promise<FolderOfferReceivedDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeOffers((offer) => {
      unsubscribe()
      resolve(offer)
    })
  })

const waitForStatus = (
  coordinator: FolderTransferCoordinator,
  status: TransferTaskDto['status'],
): Promise<TransferTaskDto> =>
  new Promise((resolve) => {
    const unsubscribe = coordinator.subscribeTasks((task) => {
      if (task.status !== status) return
      unsubscribe()
      resolve(task)
    })
  })

const sourceFolder: AuthorizedSourceFolder = {
  rootPath: '/authorized/source/项目资料',
  selection: {
    selectionToken: 's'.repeat(43),
    displayName: '项目资料',
    fileCount: 1,
    emptyDirectoryCount: 1,
    totalSize: 1_024,
  },
  manifest: {
    displayName: '项目资料',
    totalSize: 1_024,
    files: [
      {
        fileId: fileIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        relativePath: '文档/说明.txt',
        size: 1_024,
        mimeType: 'text/plain',
      },
    ],
    emptyDirectories: ['空目录'],
  },
  files: [
    {
      path: '/authorized/source/项目资料/文档/说明.txt',
      manifest: {
        fileId: fileIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        relativePath: '文档/说明.txt',
        size: 1_024,
        mimeType: 'text/plain',
      },
      identity: { device: 1, inode: 2, modifiedAt: 3 },
    },
  ],
}

const createConnectedPair = async (): Promise<{
  sender: FolderTransferCoordinator
  receiver: FolderTransferCoordinator
}> => {
  const server = new LocalServer()
  servers.push(server)
  let receiverPort = 0
  const receiverManager = new ConnectionManager(() =>
    createDevice('22222222-2222-4222-8222-222222222222', 'Receiver', receiverPort),
  )
  const senderManager = new ConnectionManager(() =>
    createDevice('11111111-1111-4111-8111-111111111111', 'Sender', 54_000),
  )
  managers.push(senderManager, receiverManager)
  const sender = new FolderTransferCoordinator(senderManager, new TestFolderAccess([sourceFolder]))
  const receiver = new FolderTransferCoordinator(receiverManager, new TestFolderAccess([]))
  coordinators.push(sender, receiver)
  server.setConnectionHandler((socket, request) => receiverManager.acceptIncoming(socket, request))
  receiverPort = await server.start(0, '127.0.0.1')

  const requestPromise = waitForRequest(receiverManager)
  const connectionPromise = senderManager.connect('127.0.0.1', receiverPort)
  const request = await requestPromise
  receiverManager.respondToRequest(request.requestId, 'accept')
  await connectionPromise
  return { sender, receiver }
}

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.shutdown()
  for (const manager of managers.splice(0)) manager.disconnect()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('folder transfer offer', () => {
  it('assembles a manifest before approval and confirms acceptance on both peers', async () => {
    const { sender, receiver } = await createConnectedPair()
    const offerPromise = waitForOffer(receiver)
    const senderAccepted = waitForStatus(sender, 'accepted')
    const receiverAccepted = waitForStatus(receiver, 'accepted')

    const outgoing = await sender.offerFolder(sourceFolder.selection.selectionToken)
    const offer = await offerPromise

    expect(outgoing).toMatchObject({
      kind: 'folder',
      status: 'awaitingAcceptance',
      totalBytes: 1_024,
    })
    expect(offer).toMatchObject({
      displayName: '项目资料',
      fileCount: 1,
      emptyDirectoryCount: 1,
      totalSize: 1_024,
    })

    await receiver.respondToOffer(offer.transferId, 'accept')
    await expect(senderAccepted).resolves.toMatchObject({ status: 'accepted' })
    await expect(receiverAccepted).resolves.toMatchObject({ status: 'accepted' })
  })

  it('propagates an explicit receiver rejection', async () => {
    const { sender, receiver } = await createConnectedPair()
    const offerPromise = waitForOffer(receiver)
    const senderRejected = waitForStatus(sender, 'rejected')

    await sender.offerFolder(sourceFolder.selection.selectionToken)
    const offer = await offerPromise
    await receiver.respondToOffer(offer.transferId, 'reject')

    await expect(senderRejected).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'FILE_REJECTED',
    })
  })

  it('does not consume the selection when another outgoing transfer is active', async () => {
    const { sender, receiver } = await createConnectedPair()
    const firstOfferPromise = waitForOffer(receiver)
    await sender.offerFolder(sourceFolder.selection.selectionToken)
    await firstOfferPromise

    await expect(sender.offerFolder(sourceFolder.selection.selectionToken)).resolves.toBeNull()
  })
})
