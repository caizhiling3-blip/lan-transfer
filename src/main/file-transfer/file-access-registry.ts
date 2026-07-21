import { randomBytes, randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname } from 'node:path'

import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import { MAX_FILE_SIZE_BYTES, MAX_FILES_PER_TRANSFER, UPLOAD_TOKEN_TTL_MS } from '@shared/constants'
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

  public constructor(
    private readonly getDefaultReceiveDirectory: () => string,
    private readonly getMaximumFileSize: () => number = () => MAX_FILE_SIZE_BYTES,
  ) {}

  public async selectFiles(
    window: BrowserWindow,
    multiple: boolean,
  ): Promise<readonly SelectedFileDto[]> {
    const result = await dialog.showOpenDialog(window, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      title: '选择要发送的文件',
    })
    if (result.canceled) return []
    return this.registerFilePaths(result.filePaths)
  }

  public async registerDroppedFiles(
    filePaths: readonly string[],
  ): Promise<readonly SelectedFileDto[]> {
    return this.registerFilePaths(filePaths)
  }

  private async registerFilePaths(
    filePaths: readonly string[],
  ): Promise<readonly SelectedFileDto[]> {
    const uniquePaths = [...new Set(filePaths)]
    if (uniquePaths.length === 0 || uniquePaths.length > MAX_FILES_PER_TRANSFER) {
      throw new Error('FILE_COUNT_EXCEEDED')
    }

    const authorizedFiles = await Promise.all(
      uniquePaths.map(async (filePath): Promise<AuthorizedSourceFile> => {
        const metadata = await stat(filePath)
        if (!metadata.isFile()) throw new Error('FILE_NOT_FOUND')
        if (metadata.size > this.getMaximumFileSize()) throw new Error('FILE_TOO_LARGE')

        const selectionToken = createToken()
        const extension = extname(filePath).toLowerCase()
        return {
          path: filePath,
          selection: {
            selectionToken,
            fileId: fileIdSchema.parse(randomUUID()),
            displayName: sanitizeFileName(basename(filePath)),
            size: metadata.size,
            mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
          },
        }
      }),
    )
    const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
    for (const authorizedFile of authorizedFiles) {
      this.sourceFiles.set(authorizedFile.selection.selectionToken, {
        value: authorizedFile,
        expiresAt,
      })
    }
    return authorizedFiles.map(({ selection }) => selection)
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

  public async consumeDirectoryToken(directoryToken: string): Promise<string> {
    const entry = this.directories.get(directoryToken)
    this.directories.delete(directoryToken)
    if (entry === undefined || entry.expiresAt < Date.now()) {
      throw new Error('SAVE_DIRECTORY_INVALID')
    }
    await this.assertWritableDirectory(entry.value)
    return entry.value
  }

  private async assertWritableDirectory(directoryPath: string): Promise<void> {
    const metadata = await stat(directoryPath)
    if (!metadata.isDirectory()) throw new Error('SAVE_DIRECTORY_INVALID')
    await access(directoryPath, constants.W_OK)
  }
}
