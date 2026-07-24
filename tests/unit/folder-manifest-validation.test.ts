import { describe, expect, it } from 'vitest'

import {
  assertFolderManifestChunkAllowed,
  hashFolderManifest,
  validateFolderManifest,
} from '../../src/main/file-transfer/folder-manifest-validation'
import type { FolderManifestContents } from '@shared/types'
import { fileIdSchema } from '@shared/types'

const firstFileId = fileIdSchema.parse('10000000-0000-4000-8000-000000000001')
const secondFileId = fileIdSchema.parse('20000000-0000-4000-8000-000000000002')

const createManifest = (): FolderManifestContents => ({
  displayName: 'Project',
  totalSize: 2,
  files: [
    {
      fileId: firstFileId,
      relativePath: 'a.txt',
      size: 1,
      mimeType: 'text/plain',
    },
    {
      fileId: secondFileId,
      relativePath: 'nested/b.txt',
      size: 1,
      mimeType: 'text/plain',
    },
  ],
  emptyDirectories: ['empty'],
})

const createOffer = (manifest: FolderManifestContents, manifestChunkCount = 1) => ({
  displayName: manifest.displayName,
  totalSize: manifest.totalSize,
  fileCount: manifest.files.length,
  emptyDirectoryCount: manifest.emptyDirectories.length,
  manifestChunkCount,
  manifestSha256: hashFolderManifest(manifest),
})

describe('folder manifest validation', () => {
  it('accepts a canonical sorted manifest and bounded chunk', () => {
    const manifest = createManifest()
    const offer = createOffer(manifest)

    expect(() =>
      assertFolderManifestChunkAllowed(offer, [
        { files: manifest.files, emptyDirectories: manifest.emptyDirectories },
      ]),
    ).not.toThrow()
    expect(() => validateFolderManifest(offer, manifest)).not.toThrow()
  })

  it('rejects unsorted paths even when the declared hash matches', () => {
    const original = createManifest()
    const manifest = { ...original, files: [...original.files].reverse() }

    expect(() => validateFolderManifest(createOffer(manifest), manifest)).toThrow(
      'PROTOCOL_INVALID',
    )
  })

  it('rejects duplicate identifiers and terminal parent path conflicts', () => {
    const original = createManifest()
    const duplicateId = {
      ...original,
      files: [original.files[0]!, { ...original.files[1]!, fileId: original.files[0]!.fileId }],
    }
    expect(() => validateFolderManifest(createOffer(duplicateId), duplicateId)).toThrow(
      'PROTOCOL_INVALID',
    )

    const parentConflict: FolderManifestContents = {
      displayName: 'Project',
      totalSize: 1,
      files: [original.files[0]!],
      emptyDirectories: ['a.txt/child'],
    }
    expect(() => validateFolderManifest(createOffer(parentConflict), parentConflict)).toThrow(
      'PROTOCOL_INVALID',
    )
  })

  it('rejects empty chunk padding and cumulative entries beyond the offer', () => {
    const manifest = createManifest()
    const paddedOffer = createOffer(manifest, 2)
    expect(() =>
      assertFolderManifestChunkAllowed(paddedOffer, [{ files: [], emptyDirectories: [] }]),
    ).toThrow('PROTOCOL_INVALID')

    const undersizedOffer = { ...createOffer(manifest), fileCount: 1 }
    expect(() =>
      assertFolderManifestChunkAllowed(undersizedOffer, [
        { files: manifest.files, emptyDirectories: [] },
      ]),
    ).toThrow('PROTOCOL_INVALID')
  })

  it('rejects a single encoded chunk above the 96 KiB limit', () => {
    const template = createManifest().files[0]!
    const oversizedFiles = Array.from({ length: 300 }, (_, index) => ({
      ...template,
      relativePath: `${String(index).padStart(3, '0')}-${'a'.repeat(480)}`,
    }))
    const offer = {
      ...createOffer(createManifest()),
      fileCount: oversizedFiles.length,
      totalSize: oversizedFiles.length,
    }

    expect(() =>
      assertFolderManifestChunkAllowed(offer, [{ files: oversizedFiles, emptyDirectories: [] }]),
    ).toThrow('PROTOCOL_INVALID')
  })

  it('allows the single canonical empty chunk for an empty folder', () => {
    const manifest: FolderManifestContents = {
      displayName: 'Empty',
      totalSize: 0,
      files: [],
      emptyDirectories: [],
    }
    expect(() =>
      assertFolderManifestChunkAllowed(createOffer(manifest), [
        { files: [], emptyDirectories: [] },
      ]),
    ).not.toThrow()
  })
})
