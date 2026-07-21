import { describe, expect, it } from 'vitest'

import { sanitizeFileName } from '../../src/main/security/file-name'
import { getUtf8ByteLength } from '@shared/utils'

describe('sanitizeFileName', () => {
  it('removes traversal and cross-platform invalid characters', () => {
    expect(sanitizeFileName('../report<final>?.txt')).toBe('.._report_final__.txt')
  })

  it('guards Windows reserved names and trailing characters', () => {
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFileName('report. ')).toBe('report')
  })

  it('preserves an extension while limiting UTF-8 byte length', () => {
    const result = sanitizeFileName(`${'文'.repeat(200)}.txt`)
    expect(getUtf8ByteLength(result)).toBeLessThanOrEqual(255)
    expect(result.endsWith('.txt')).toBe(true)
  })
})
