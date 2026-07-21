import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import {
  DIRECTORY_SELECTION_TOKEN_TTL_MS,
  FILE_SELECTION_TOKEN_TTL_MS,
  MAX_AUTHORIZED_DIRECTORIES,
  MAX_AUTHORIZED_FILE_SELECTIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
} from '@shared/constants'
import { fileIdSchema } from '@shared/types'
import type { SelectedDirectoryDto, SelectedFileDto } from '@shared/types'

import { assertSafeReceiveDirectory, sanitizeFileName } from '../security'

export interface AuthorizedSourceFile {
  readonly path: string
  readonly selection: SelectedFileDto
  readonly identity?: {
    readonly device: number
    readonly inode: number
    readonly modifiedAt: number
  }
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
    private readonly protectedDirectories: readonly string[] = [],
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

    this.pruneExpired()
    const authorizedFiles = await Promise.all(
      uniquePaths.map(async (filePath): Promise<AuthorizedSourceFile> => {
        if (!isAbsolute(filePath)) throw new Error('FILE_NOT_FOUND')
        const selectedMetadata = await lstat(filePath)
        if (!selectedMetadata.isFile() || selectedMetadata.isSymbolicLink()) {
          throw new Error('FILE_NOT_FOUND')
        }
        const canonicalPath = await realpath(filePath)
        const metadata = await lstat(canonicalPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('FILE_NOT_FOUND')
        if (metadata.size > this.getMaximumFileSize()) throw new Error('FILE_TOO_LARGE')

        const selectionToken = createToken()
        const extension = extname(filePath).toLowerCase()
        return {
          path: canonicalPath,
          identity: {
            device: metadata.dev,
            inode: metadata.ino,
            modifiedAt: metadata.mtimeMs,
          },
          selection: {
            selectionToken,
            fileId: fileIdSchema.parse(randomUUID()),
            displayName: sanitizeFileName(basename(canonicalPath)),
            size: metadata.size,
            mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
          },
        }
      }),
    )
    const expiresAt = Date.now() + FILE_SELECTION_TOKEN_TTL_MS
    for (const authorizedFile of authorizedFiles) {
      this.sourceFiles.set(authorizedFile.selection.selectionToken, {
        value: authorizedFile,
        expiresAt,
      })
    }
    this.enforceLimit(this.sourceFiles, MAX_AUTHORIZED_FILE_SELECTIONS)
    return authorizedFiles.map(({ selection }) => selection)
  }

  public consumeSource(selectionToken: string): AuthorizedSourceFile | null {
    const entry = this.sourceFiles.get(selectionToken)
    this.sourceFiles.delete(selectionToken)
    if (entry === undefined || entry.expiresAt < Date.now()) return null
    return entry.value
  }

  public async selectReceiveDirectory(window: BrowserWindow): Promise<SelectedDirectoryDto | null> {
    this.pruneExpired()
    const result = await dialog.showOpenDialog(window, {
      defaultPath: this.getDefaultReceiveDirectory(),
      properties: ['openDirectory', 'createDirectory'],
      title: '选择本次接收目录',
    })
    const directoryPath = result.filePaths[0]
    if (result.canceled || directoryPath === undefined) return null
    const safeDirectoryPath = await this.assertWritableDirectory(directoryPath)
    const directoryToken = createToken()
    this.directories.set(directoryToken, {
      value: safeDirectoryPath,
      expiresAt: Date.now() + DIRECTORY_SELECTION_TOKEN_TTL_MS,
    })
    this.enforceLimit(this.directories, MAX_AUTHORIZED_DIRECTORIES)
    return { directoryToken, displayPath: safeDirectoryPath }
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
    return this.assertWritableDirectory(directoryPath)
  }

  public async consumeDirectoryToken(directoryToken: string): Promise<string> {
    const entry = this.directories.get(directoryToken)
    this.directories.delete(directoryToken)
    if (entry === undefined || entry.expiresAt < Date.now()) {
      throw new Error('SAVE_DIRECTORY_INVALID')
    }
    return this.assertWritableDirectory(entry.value)
  }

  private assertWritableDirectory(directoryPath: string): Promise<string> {
    return assertSafeReceiveDirectory(directoryPath, this.protectedDirectories)
  }

  private pruneExpired(now = Date.now()): void {
    for (const [token, entry] of this.sourceFiles) {
      if (entry.expiresAt < now) this.sourceFiles.delete(token)
    }
    for (const [token, entry] of this.directories) {
      if (entry.expiresAt < now) this.directories.delete(token)
    }
  }

  private enforceLimit<T>(values: Map<string, T>, maximumEntries: number): void {
    while (values.size > maximumEntries) {
      const oldestToken = values.keys().next().value
      if (oldestToken === undefined) return
      values.delete(oldestToken)
    }
  }
}
