import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import {
  DIRECTORY_SELECTION_TOKEN_TTL_MS,
  FILE_SELECTION_TOKEN_TTL_MS,
  MAX_AUTHORIZED_DIRECTORIES,
  MAX_AUTHORIZED_FOLDER_SELECTIONS,
  MAX_AUTHORIZED_FILE_SELECTIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_TRANSFER,
  MAX_TOP_LEVEL_TRANSFER_ITEMS,
} from '@shared/constants'
import { fileIdSchema } from '@shared/types'
import type {
  SelectedDirectoryDto,
  SelectedFileDto,
  SelectedFolderDto,
  SelectedTransferItemDto,
} from '@shared/types'

import { assertSafeReceiveDirectory, sanitizeFileName } from '../security'
import { scanFolder } from './folder-scanner'
import type { AuthorizedFolderFile } from './folder-scanner'
import { getMimeType } from './mime-type'

export interface AuthorizedSourceFile {
  readonly path: string
  readonly selection: SelectedFileDto
  readonly identity?: {
    readonly device: number
    readonly inode: number
    readonly modifiedAt: number
  }
}

export interface AuthorizedSourceFolder {
  readonly rootPath: string
  readonly selection: SelectedFolderDto
  readonly manifest: Awaited<ReturnType<typeof scanFolder>>['manifest']
  readonly files: readonly AuthorizedFolderFile[]
}

export interface AuthorizedTransferSelections {
  readonly files: readonly AuthorizedSourceFile[]
  readonly folders: readonly AuthorizedSourceFolder[]
}

interface ExpiringValue<T> {
  readonly value: T
  readonly expiresAt: number
}

const createToken = (): string => randomBytes(32).toString('base64url')

export class FileAccessRegistry {
  private readonly sourceFiles = new Map<string, ExpiringValue<AuthorizedSourceFile>>()
  private readonly sourceFolders = new Map<string, ExpiringValue<AuthorizedSourceFolder>>()
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

  public async selectFolder(window: BrowserWindow): Promise<SelectedFolderDto | null> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: '选择要发送的文件夹',
    })
    const folderPath = result.filePaths[0]
    if (result.canceled || folderPath === undefined) return null
    const folder = await this.authorizeFolderPath(folderPath)
    this.storeAuthorizedFolders([folder])
    return folder.selection
  }

  public async registerDroppedItems(
    itemPaths: readonly string[],
  ): Promise<readonly SelectedTransferItemDto[]> {
    const uniquePaths = [...new Set(itemPaths)]
    if (uniquePaths.length === 0 || uniquePaths.length > MAX_FILES_PER_TRANSFER) {
      throw new Error('FILE_COUNT_EXCEEDED')
    }
    this.pruneExpired()
    const itemMetadata = await Promise.all(
      uniquePaths.map(async (itemPath) => {
        if (!isAbsolute(itemPath)) throw new Error('FILE_NOT_FOUND')
        const metadata = await lstat(itemPath).catch(() => null)
        if (metadata === null) throw new Error('FILE_NOT_FOUND')
        if (metadata.isSymbolicLink()) throw new Error('FOLDER_SYMLINK_UNSUPPORTED')
        return { itemPath, metadata }
      }),
    )
    if (
      itemMetadata.some(({ metadata }) => metadata.isDirectory()) &&
      itemMetadata.length > MAX_TOP_LEVEL_TRANSFER_ITEMS
    ) {
      throw new Error('FILE_COUNT_EXCEEDED')
    }
    const authorizedFiles: AuthorizedSourceFile[] = []
    const authorizedFolders: AuthorizedSourceFolder[] = []
    const selections: SelectedTransferItemDto[] = []
    for (const { itemPath, metadata } of itemMetadata) {
      if (metadata.isFile()) {
        const file = await this.authorizeFilePath(itemPath)
        authorizedFiles.push(file)
        selections.push({ kind: 'file', file: file.selection })
      } else if (metadata.isDirectory()) {
        const folder = await this.authorizeFolderPath(itemPath)
        authorizedFolders.push(folder)
        selections.push({ kind: 'folder', folder: folder.selection })
      } else {
        throw new Error('FOLDER_PATH_INVALID')
      }
    }
    this.storeAuthorizedFiles(authorizedFiles)
    this.storeAuthorizedFolders(authorizedFolders)
    return selections
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
      uniquePaths.map((filePath) => this.authorizeFilePath(filePath)),
    )
    this.storeAuthorizedFiles(authorizedFiles)
    return authorizedFiles.map(({ selection }) => selection)
  }

  private async authorizeFilePath(filePath: string): Promise<AuthorizedSourceFile> {
    if (!isAbsolute(filePath)) throw new Error('FILE_NOT_FOUND')
    const selectedMetadata = await lstat(filePath)
    if (!selectedMetadata.isFile() || selectedMetadata.isSymbolicLink()) {
      throw new Error('FILE_NOT_FOUND')
    }
    const canonicalPath = await realpath(filePath)
    const metadata = await lstat(canonicalPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('FILE_NOT_FOUND')
    if (metadata.size > this.getMaximumFileSize()) throw new Error('FILE_TOO_LARGE')
    return {
      path: canonicalPath,
      identity: {
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtimeMs,
      },
      selection: {
        selectionToken: createToken(),
        fileId: fileIdSchema.parse(randomUUID()),
        displayName: sanitizeFileName(basename(canonicalPath)),
        size: metadata.size,
        mimeType: getMimeType(canonicalPath),
      },
    }
  }

  private async authorizeFolderPath(folderPath: string): Promise<AuthorizedSourceFolder> {
    const scanned = await scanFolder(folderPath, { maximumFileSize: this.getMaximumFileSize() })
    return {
      rootPath: scanned.rootPath,
      manifest: scanned.manifest,
      files: scanned.files,
      selection: {
        selectionToken: createToken(),
        displayName: scanned.manifest.displayName,
        fileCount: scanned.manifest.files.length,
        emptyDirectoryCount: scanned.manifest.emptyDirectories.length,
        totalSize: scanned.manifest.totalSize,
      },
    }
  }

  private storeAuthorizedFiles(files: readonly AuthorizedSourceFile[]): void {
    const expiresAt = Date.now() + FILE_SELECTION_TOKEN_TTL_MS
    for (const file of files) {
      this.sourceFiles.set(file.selection.selectionToken, { value: file, expiresAt })
    }
    this.enforceLimit(this.sourceFiles, MAX_AUTHORIZED_FILE_SELECTIONS)
  }

  private storeAuthorizedFolders(folders: readonly AuthorizedSourceFolder[]): void {
    const expiresAt = Date.now() + FILE_SELECTION_TOKEN_TTL_MS
    for (const folder of folders) {
      this.sourceFolders.set(folder.selection.selectionToken, { value: folder, expiresAt })
    }
    this.enforceLimit(this.sourceFolders, MAX_AUTHORIZED_FOLDER_SELECTIONS)
  }

  public consumeSource(selectionToken: string): AuthorizedSourceFile | null {
    const entry = this.sourceFiles.get(selectionToken)
    this.sourceFiles.delete(selectionToken)
    if (entry === undefined || entry.expiresAt < Date.now()) return null
    return entry.value
  }

  public consumeTransferSelections(
    fileSelectionTokens: readonly string[],
    folderSelectionTokens: readonly string[],
  ): AuthorizedTransferSelections | null {
    this.pruneExpired()
    const files = fileSelectionTokens.map((token) => this.sourceFiles.get(token)?.value)
    const folders = folderSelectionTokens.map((token) => this.sourceFolders.get(token)?.value)
    if (
      files.some((file) => file === undefined) ||
      folders.some((folder) => folder === undefined)
    ) {
      return null
    }
    for (const token of fileSelectionTokens) this.sourceFiles.delete(token)
    for (const token of folderSelectionTokens) this.sourceFolders.delete(token)
    return {
      files: files.filter((file) => file !== undefined),
      folders: folders.filter((folder) => folder !== undefined),
    }
  }

  public consumeFolder(selectionToken: string): AuthorizedSourceFolder | null {
    const entry = this.sourceFolders.get(selectionToken)
    this.sourceFolders.delete(selectionToken)
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
    for (const [token, entry] of this.sourceFolders) {
      if (entry.expiresAt < now) this.sourceFolders.delete(token)
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
