import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  validateMacReleaseEnvironment,
  validateWindowsReleaseEnvironment,
} from '../../scripts/validate-release-credentials.mjs'

describe('release configuration', () => {
  it('requires certificate and notarization credential names without exposing values', () => {
    const secret = 'must-not-appear-in-errors'
    const missing = validateMacReleaseEnvironment({ CSC_LINK: secret })
    expect(missing).toContain('CSC_KEY_PASSWORD')
    expect(missing.join(' ')).not.toContain(secret)

    expect(
      validateMacReleaseEnvironment({
        CSC_LINK: secret,
        CSC_KEY_PASSWORD: secret,
        APPLE_API_KEY: secret,
        APPLE_API_KEY_ID: secret,
        APPLE_API_ISSUER: secret,
      }),
    ).toEqual([])
  })

  it('allows either platform-specific or shared Windows certificate variables', () => {
    expect(
      validateWindowsReleaseEnvironment({
        WIN_CSC_LINK: 'certificate',
        WIN_CSC_KEY_PASSWORD: 'password',
        WIN_CSC_NAME: 'Lindu Publisher',
      }),
    ).toEqual([])
    expect(
      validateWindowsReleaseEnvironment({
        CSC_LINK: 'certificate',
        CSC_KEY_PASSWORD: 'password',
        WIN_CSC_NAME: 'Lindu Publisher',
      }),
    ).toEqual([])
  })

  it('enables hardened runtime and notarization only in the macOS release config', async () => {
    const [base, release, entitlements, inheritedEntitlements] = await Promise.all([
      readFile('electron-builder.yml', 'utf8'),
      readFile('electron-builder.mac-release.yml', 'utf8'),
      readFile('build/entitlements.mac.plist', 'utf8'),
      readFile('build/entitlements.mac.inherit.plist', 'utf8'),
    ])
    expect(base).toContain('hardenedRuntime: false')
    expect(base).toContain('notarize: false')
    expect(release).toContain('hardenedRuntime: true')
    expect(release).toContain('notarize: true')
    expect(release).toContain('forceCodeSigning: true')
    expect(entitlements).toContain('com.apple.security.network.server')
    expect(entitlements).not.toContain('com.apple.security.app-sandbox')
    expect(inheritedEntitlements).not.toContain('com.apple.security.network.server')
  })

  it('forces SHA-256 Authenticode signing for Windows release artifacts', async () => {
    const [base, release] = await Promise.all([
      readFile('electron-builder.yml', 'utf8'),
      readFile('electron-builder.win-release.yml', 'utf8'),
    ])
    expect(base).toContain('forceCodeSigning: false')
    expect(release).toContain('forceCodeSigning: true')
    expect(release).toContain('certificateSubjectName: ${env.WIN_CSC_NAME}')
    expect(release).toContain('publisherName:')
    expect(release).toContain('- sha256')
    expect(release).toContain('rfc3161TimeStampServer: http://timestamp.digicert.com')
  })
})
