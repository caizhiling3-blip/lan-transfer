import { describe, expect, it } from 'vitest'

import {
  stableVersionSchema,
  UPDATE_ERROR_CODES,
  UPDATE_STATES,
  updateReleaseInfoSchema,
  updateStatusSchema,
} from '@shared/types'

describe('update contracts', () => {
  it('accepts stable semantic versions only', () => {
    expect(stableVersionSchema.parse('0.5.0')).toBe('0.5.0')
    for (const version of ['v0.5.0', '0.5', '0.5.0-beta.1', '01.5.0', 'latest']) {
      expect(() => stableVersionSchema.parse(version)).toThrow()
    }
  })

  it('keeps public release information free of URLs, paths, hashes, and credentials', () => {
    expect(
      updateReleaseInfoSchema.parse({
        version: '0.5.0',
        releaseNotes: 'Security and reliability improvements.',
        publishedAt: 123_456,
      }),
    ).toEqual({
      version: '0.5.0',
      releaseNotes: 'Security and reliability improvements.',
      publishedAt: 123_456,
    })
    for (const field of ['url', 'path', 'sha256', 'token', 'authorization']) {
      expect(() =>
        updateReleaseInfoSchema.parse({ version: '0.5.0', [field]: 'sensitive' }),
      ).toThrow()
    }
  })

  it('enforces state-specific update projections', () => {
    expect(
      updateStatusSchema.parse({
        state: 'downloaded',
        currentVersion: '0.4.0',
        availableUpdate: { version: '0.5.0' },
        downloadProgress: 100,
        canInstall: false,
      }),
    ).toMatchObject({ state: 'downloaded', canInstall: false })
    expect(() =>
      updateStatusSchema.parse({
        state: 'downloading',
        currentVersion: '0.4.0',
        availableUpdate: { version: '0.5.0' },
        downloadProgress: 101,
        canInstall: false,
      }),
    ).toThrow()
    expect(() =>
      updateStatusSchema.parse({
        state: 'error',
        currentVersion: '0.4.0',
        errorCode: 'NETWORK_UNREACHABLE',
        canInstall: false,
      }),
    ).toThrow()
  })

  it('keeps state and error code lists unique', () => {
    expect(new Set(UPDATE_STATES).size).toBe(UPDATE_STATES.length)
    expect(new Set(UPDATE_ERROR_CODES).size).toBe(UPDATE_ERROR_CODES.length)
  })
})
