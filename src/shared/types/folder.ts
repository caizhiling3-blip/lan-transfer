import type { FileId } from './identifiers'
import type { SelectedFileDto } from './app'

export interface FolderManifestFile {
  readonly fileId: FileId
  readonly relativePath: string
  readonly size: number
  readonly mimeType: string
}

export interface FolderManifestContents {
  readonly displayName: string
  readonly totalSize: number
  readonly files: readonly FolderManifestFile[]
  readonly emptyDirectories: readonly string[]
}

export interface SelectedFolderDto {
  readonly selectionToken: string
  readonly displayName: string
  readonly fileCount: number
  readonly emptyDirectoryCount: number
  readonly totalSize: number
}

export type SelectedTransferItemDto =
  | { readonly kind: 'file'; readonly file: SelectedFileDto }
  | { readonly kind: 'folder'; readonly folder: SelectedFolderDto }
