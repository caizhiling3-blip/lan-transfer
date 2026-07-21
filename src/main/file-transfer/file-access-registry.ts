import { randomBytes, randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname } from 'node:path'

import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import { MAX_FILE_SIZE_BYTES, UPLOAD_TOKEN_TTL_MS } from '@shared/constants'
import { fileIdSchema } from '@shared/types'
import type { SelectedDirectoryDto, SelectedFileDto } from '@shared/types'

import { sanitizeFileName } from '../security'

export interface AuthorizedSourceFile {
  readonly path: string
  readonly selection: SelectedFileDto
}

interface ExpiringValue<T> {
  readonly value: T
  readonly expiresAt: number
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

const createToken = (): string => randomBytes(32).toString('base64url')

export class FileAccessRegistry {
  private readonly sourceFiles = new Map<string, ExpiringValue<AuthorizedSourceFile>>()
  private readonly directories = new Map<string, ExpiringValue<string>>()

  public constructor(private readonly getDefaultReceiveDirectory: () => string) {}

  public async selectSingleFile(window: BrowserWindow): Promise<readonly SelectedFileDto[]> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: '选择要发送的文件',
    })
    const filePath = result.filePaths[0]
    if (result.canceled || filePath === undefined) return []

    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new Error('FILE_NOT_FOUND')
    if (metadata.size > MAX_FILE_SIZE_BYTES) throw new Error('FILE_TOO_LARGE')

    const selectionToken = createToken()
    const extension = extname(filePath).toLowerCase()
    const selection: SelectedFileDto = {
      selectionToken,
      fileId: fileIdSchema.parse(randomUUID()),
      displayName: sanitizeFileName(basename(filePath)),
      size: metadata.size,
      mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
    }
    this.sourceFiles.set(selectionToken, {
      value: { path: filePath, selection },
      expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS,
    })
    return [selection]
  }

  public consumeSource(selectionToken: string): AuthorizedSourceFile | null {
    const entry = this.sourceFiles.get(selectionToken)
    this.sourceFiles.delete(selectionToken)
    if (entry === undefined || entry.expiresAt < Date.now()) return null
    return entry.value
  }

  public async selectReceiveDirectory(window: BrowserWindow): Promise<SelectedDirectoryDto | null> {
    const result = await dialog.showOpenDialog(window, {
      defaultPath: this.getDefaultReceiveDirectory(),
      properties: ['openDirectory', 'createDirectory'],
      title: '选择本次接收目录',
    })
    const directoryPath = result.filePaths[0]
    if (result.canceled || directoryPath === undefined) return null
    await this.assertWritableDirectory(directoryPath)
    const directoryToken = createToken()
    this.directories.set(directoryToken, {
      value: directoryPath,
      expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS,
    })
    return { directoryToken, displayPath: directoryPath }
  }

  public async resolveReceiveDirectory(directoryToken?: string): Promise<string> {
    let directoryPath = this.getDefaultReceiveDirectory()
    if (directoryToken !== undefined) {
      const entry = this.directories.get(directoryToken)
      this.directories.delete(directoryToken)
      if (entry === undefined || entry.expiresAt < Date.now()) {
        throw new Error('SAVE_DIRECTORY_INVALID')
      }
      directoryPath = entry.value
    }
    await this.assertWritableDirectory(directoryPath)
    return directoryPath
  }

  private async assertWritableDirectory(directoryPath: string): Promise<void> {
    const metadata = await stat(directoryPath)
    if (!metadata.isDirectory()) throw new Error('SAVE_DIRECTORY_INVALID')
    await access(directoryPath, constants.W_OK)
  }
}
