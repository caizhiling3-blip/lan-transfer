import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { maskIpAddressForDiagnostics } from '../../src/main/diagnostics/diagnostics-service'
import { LogLifecycle } from '../../src/main/logger/log-lifecycle'
const createTemporaryDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), 'lindu-logs-'))

describe('LogLifecycle', () => {
  it('counts only known regular log files and keeps the active log when clearing', async () => {
    const directory = await createTemporaryDirectory()
    const activePath = join(directory, 'main.log')
    const rotatedPath = join(directory, 'main.old.log')
    await writeFile(activePath, 'active', 'utf8')
    await writeFile(rotatedPath, 'rotated', 'utf8')
    await writeFile(join(directory, 'other.log'), 'unrelated', 'utf8')
    await mkdir(join(directory, 'main.1.log'))
    await symlink(rotatedPath, join(directory, 'main.2.log'))
    const lifecycle = new LogLifecycle(directory, () => activePath)

    await expect(lifecycle.getStats()).resolves.toMatchObject({ fileCount: 2, storageBytes: 13 })
    await expect(lifecycle.clearInactiveLogs()).resolves.toBe(1)
    await expect(readFile(activePath, 'utf8')).resolves.toBe('active')
    await expect(readFile(join(directory, 'other.log'), 'utf8')).resolves.toBe('unrelated')
  })

  it('removes only expired inactive known logs', async () => {
    const directory = await createTemporaryDirectory()
    const activePath = join(directory, 'main.log')
    const rotatedPath = join(directory, 'main.old.log')
    await writeFile(activePath, 'active', 'utf8')
    await writeFile(rotatedPath, 'old', 'utf8')
    const oldDate = new Date(Date.now() - 40 * 86_400_000)
    await utimes(rotatedPath, oldDate, oldDate)
    const lifecycle = new LogLifecycle(directory, () => activePath)

    await expect(lifecycle.cleanupExpired(30)).resolves.toBe(1)
    await expect(lifecycle.getStats()).resolves.toMatchObject({ fileCount: 1 })
  })
})

describe('diagnostic redaction', () => {
  it('keeps only an IPv4 network prefix', () => {
    expect(maskIpAddressForDiagnostics('192.168.10.42')).toBe('192.168.10.x')
    expect(maskIpAddressForDiagnostics('not-an-ip')).toBe('hidden')
  })
})
