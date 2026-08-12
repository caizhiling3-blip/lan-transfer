import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { MOBILE_UPLOAD_SESSION_TTL_MS } from '@shared/constants'
import {
  isMobileUploadRequestTimestampCurrent,
  mobileUploadOfferRequestSchema,
  mobileUploadRequestAuthenticationSchema,
} from '@shared/protocols'
import { fileIdSchema, mobileUploadBatchIdSchema } from '@shared/types'

import { MobileUploadCoordinator } from '../../src/main/mobile-upload'
import { LocalServer } from '../../src/main/server'

const FILE_ID = '11111111-1111-4111-8111-111111111111'
const BATCH_ID = '22222222-2222-4222-8222-222222222222'

describe('mobile upload shared contracts', () => {
  it('accepts a strict bounded offer', () => {
    expect(
      mobileUploadOfferRequestSchema.parse({
        batchId: BATCH_ID,
        files: [{ fileId: FILE_ID, displayName: '照片.jpg', size: 42, mimeType: 'image/jpeg' }],
      }).files,
    ).toHaveLength(1)
    expect(() =>
      mobileUploadOfferRequestSchema.parse({
        batchId: BATCH_ID,
        files: [{ fileId: FILE_ID, displayName: '../secret', size: 42, mimeType: 'image/jpeg' }],
      }),
    ).toThrow()
  })

  it('rejects malformed authentication and stale timestamps', () => {
    expect(() =>
      mobileUploadRequestAuthenticationSchema.parse({
        timestamp: 1_000,
        nonce: 'n'.repeat(16),
        sessionKey: 'short',
      }),
    ).toThrow()
    expect(isMobileUploadRequestTimestampCurrent(1_000, 61_001)).toBe(false)
    expect(isMobileUploadRequestTimestampCurrent(1_000, 61_000)).toBe(true)
  })
})

describe('MobileUploadCoordinator', () => {
  it('creates one short-lived session and keeps the key in the URL fragment', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const coordinator = new MobileUploadCoordinator(() => [
      'http://192.168.1.2:53317',
      'http://192.168.1.2:53317',
    ])
    const created = coordinator.createSession()

    expect(created.secret).toHaveLength(43)
    expect(created.session.urls).toEqual([
      `http://192.168.1.2:53317/mobile/${created.session.sessionId}#key=${created.secret}`,
    ])
    expect(created.session.expiresAt).toBe(1_000 + MOBILE_UPLOAD_SESSION_TTL_MS)
    expect(coordinator.getSecret(created.session.sessionId)).toBe(created.secret)

    vi.advanceTimersByTime(MOBILE_UPLOAD_SESSION_TTL_MS)
    expect(coordinator.getSession()).toBeNull()
    vi.useRealTimers()
  })

  it('replaces and closes the previous session', () => {
    let address = 'http://10.0.0.2:53317'
    const coordinator = new MobileUploadCoordinator(() => [address])
    const first = coordinator.createSession()
    address = 'http://172.20.10.2:53317'
    const second = coordinator.createSession()

    expect(second.session.sessionId).not.toBe(first.session.sessionId)
    expect(second.session.urls[0]?.startsWith('http://172.20.10.2:53317/mobile/')).toBe(true)
    expect(coordinator.getSecret(first.session.sessionId)).toBeNull()
    expect(coordinator.closeSession()?.state).toBe('closed')
    expect(coordinator.getSession()).toBeNull()
  })

  it('serves a locked-down page and accepts only authenticated offers', async () => {
    const server = new LocalServer()
    const originPlaceholder = 'http://127.0.0.1:0'
    let origin = originPlaceholder
    const coordinator = new MobileUploadCoordinator(() => [origin])
    server.setRequestHandler((request, response) =>
      coordinator.handleHttpRequest(request, response),
    )
    const port = await server.start(0, '127.0.0.1')
    origin = `http://127.0.0.1:${String(port)}`
    const created = coordinator.createSession()
    const pagePath = `/mobile/${created.session.sessionId}`
    const page = await fetch(`${origin}${pagePath}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    const pageContent = await page.text()
    expect(pageContent).toContain(
      'await upload(files,metadata,batchId);selected=[];busy=false;render()',
    )
    expect(pageContent).toContain(
      "status.textContent='本次会话已结束，请在电脑上重新创建二维码后扫码。'",
    )
    expect(pageContent).toContain('if(response.status===401||response.status===404)')

    const batchId = BATCH_ID
    const offerPath = `${pagePath}/offers`
    const body = JSON.stringify({
      batchId,
      files: [{ fileId: FILE_ID, displayName: 'photo.jpg', size: 42, mimeType: 'image/jpeg' }],
    })
    const unauthorized = await fetch(`${origin}${offerPath}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', Origin: origin },
    })
    expect(unauthorized.status).toBe(401)

    const signedHeaders = createSignedHeaders('POST', offerPath, body, created.secret, origin)
    const accepted = await fetch(`${origin}${offerPath}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
    })
    expect(accepted.status).toBe(202)
    expect(coordinator.getPendingOffer()?.files[0]?.displayName).toBe('photo.jpg')

    const replayed = await fetch(`${origin}${offerPath}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
    })
    expect(replayed.status).toBe(401)
    await server.stop()
    coordinator.shutdown()
  })

  it('publishes an authenticated fixed chunk only after PC acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lindu-mobile-'))
    const server = new LocalServer()
    let origin = 'http://127.0.0.1:0'
    const coordinator = new MobileUploadCoordinator(() => [origin], {
      resolveReceiveDirectory: async () => directory,
    })
    server.setRequestHandler((request, response) =>
      coordinator.handleHttpRequest(request, response),
    )
    const port = await server.start(0, '127.0.0.1')
    origin = `http://127.0.0.1:${String(port)}`
    const created = coordinator.createSession()
    const basePath = `/mobile/${created.session.sessionId}`
    const content = Buffer.from('mobile upload works')
    const body = JSON.stringify({
      batchId: BATCH_ID,
      files: [
        {
          fileId: FILE_ID,
          displayName: 'mobile.txt',
          size: content.length,
          mimeType: 'text/plain',
        },
      ],
    })
    const offerPath = `${basePath}/offers`
    const offer = await fetch(`${origin}${offerPath}`, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...createSignedHeaders('POST', offerPath, body, created.secret, origin),
      },
    })
    expect(offer.status).toBe(202)
    await coordinator.respondToOffer(mobileUploadBatchIdSchema.parse(BATCH_ID), 'accept')

    const chunkPath = `${basePath}/batches/${BATCH_ID}/files/${FILE_ID}/chunks/0`
    const uploaded = await fetch(`${origin}${chunkPath}`, {
      method: 'PUT',
      body: content,
      headers: {
        'Content-Type': 'application/octet-stream',
        ...createSignedHeaders(
          'PUT',
          chunkPath,
          content,
          created.secret,
          origin,
          'chunk-nonce-123456',
        ),
      },
    })
    expect(uploaded.status).toBe(200)
    await expect(readFile(join(directory, 'mobile.txt'), 'utf8')).resolves.toBe(
      'mobile upload works',
    )
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([])

    await server.stop()
    coordinator.shutdown()
    await rm(directory, { recursive: true })
  })

  it('uploads multiple files serially in one browser batch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lindu-mobile-multiple-'))
    const server = new LocalServer()
    let origin = 'http://127.0.0.1:0'
    const coordinator = new MobileUploadCoordinator(() => [origin], {
      resolveReceiveDirectory: async () => directory,
    })
    server.setRequestHandler((request, response) =>
      coordinator.handleHttpRequest(request, response),
    )
    const port = await server.start(0, '127.0.0.1')
    origin = `http://127.0.0.1:${String(port)}`
    const created = coordinator.createSession()
    const basePath = `/mobile/${created.session.sessionId}`
    const secondFileId = '33333333-3333-4333-8333-333333333333'
    const files = [
      { fileId: FILE_ID, displayName: 'empty.txt', content: Buffer.alloc(0) },
      { fileId: secondFileId, displayName: 'second.txt', content: Buffer.from('second file') },
    ]
    const offerBody = JSON.stringify({
      batchId: BATCH_ID,
      files: files.map((file) => ({
        fileId: file.fileId,
        displayName: file.displayName,
        size: file.content.length,
        mimeType: 'text/plain',
      })),
    })
    const offerPath = `${basePath}/offers`
    expect(
      (
        await fetch(`${origin}${offerPath}`, {
          method: 'POST',
          body: offerBody,
          headers: {
            'Content-Type': 'application/json',
            ...createSignedHeaders('POST', offerPath, offerBody, created.secret, origin),
          },
        })
      ).status,
    ).toBe(202)
    await coordinator.respondToOffer(mobileUploadBatchIdSchema.parse(BATCH_ID), 'accept')

    for (const [index, file] of files.entries()) {
      const chunkPath = `${basePath}/batches/${BATCH_ID}/files/${file.fileId}/chunks/0`
      const response = await fetch(`${origin}${chunkPath}`, {
        method: 'PUT',
        body: file.content,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...createSignedHeaders(
            'PUT',
            chunkPath,
            file.content,
            created.secret,
            origin,
            `multi-file-nonce-${String(index)}`,
          ),
        },
      })
      expect(response.status).toBe(200)
    }

    await expect(readFile(join(directory, 'empty.txt'))).resolves.toHaveLength(0)
    await expect(readFile(join(directory, 'second.txt'), 'utf8')).resolves.toBe('second file')
    await server.stop()
    coordinator.shutdown()
    await rm(directory, { recursive: true })
  })

  it('publishes an authorized PC file for authenticated mobile download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lindu-mobile-download-'))
    const sourcePath = join(directory, '电脑文件.txt')
    const content = Buffer.from('download from pc')
    await writeFile(sourcePath, content)
    const metadata = await import('node:fs/promises').then(({ stat }) => stat(sourcePath))
    const selectionToken = 'selection-token-for-mobile-download'
    const source = {
      path: sourcePath,
      identity: {
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtimeMs,
      },
      selection: {
        selectionToken,
        fileId: fileIdSchema.parse(FILE_ID),
        displayName: '电脑文件.txt',
        size: content.length,
        mimeType: 'text/plain',
      },
    }
    const server = new LocalServer()
    let origin = 'http://127.0.0.1:0'
    const coordinator = new MobileUploadCoordinator(() => [origin], {
      resolveReceiveDirectory: async () => directory,
      consumeTransferSelections: (tokens, folders) =>
        tokens.length === 1 && tokens[0] === selectionToken && folders.length === 0
          ? { files: [source] }
          : null,
    })
    server.setRequestHandler((request, response) =>
      coordinator.handleHttpRequest(request, response),
    )
    const port = await server.start(0, '127.0.0.1')
    origin = `http://127.0.0.1:${String(port)}`
    const created = coordinator.createSession()
    expect(coordinator.publishDownloads([selectionToken])?.files[0]?.status).toBe('available')

    const listPath = `/mobile/${created.session.sessionId}/downloads`
    expect((await fetch(`${origin}${listPath}`)).status).toBe(401)
    const listResponse = await fetch(`${origin}${listPath}`, {
      headers: createSignedHeaders('GET', listPath, '', created.secret, origin),
    })
    expect(listResponse.status).toBe(200)
    const list = (await listResponse.json()) as {
      readonly files: readonly [{ readonly downloadUrl: string }]
    }
    const invalidDownload = await fetch(`${origin}${list.files[0].downloadUrl.slice(0, -1)}x`)
    expect(invalidDownload.status).toBe(404)
    const downloaded = new Promise<void>((resolve) => {
      const unsubscribe = coordinator.subscribeDownloads((batch) => {
        if (batch?.files[0]?.status !== 'downloaded') return
        unsubscribe()
        resolve()
      })
    })
    const downloadResponse = await fetch(`${origin}${list.files[0].downloadUrl}`)
    expect(downloadResponse.status).toBe(200)
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''%E7%94%B5%E8%84%91%E6%96%87%E4%BB%B6.txt",
    )
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(content)
    await downloaded
    expect(coordinator.getDownloads()?.files[0]?.status).toBe('downloaded')

    await server.stop()
    coordinator.shutdown()
    await rm(directory, { recursive: true })
  })
})

const createSignedHeaders = (
  _method: string,
  _path: string,
  _body: string | Buffer,
  secret: string,
  origin: string,
  nonce = 'test-nonce-123456',
): Record<string, string> => {
  void _method
  void _path
  void _body
  const timestamp = Date.now().toString()
  return {
    Origin: origin,
    'X-Lindu-Timestamp': timestamp,
    'X-Lindu-Nonce': nonce,
    'X-Lindu-Session-Key': secret,
  }
}
