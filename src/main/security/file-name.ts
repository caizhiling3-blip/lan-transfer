import { extname } from 'node:path'

import { getUtf8ByteLength } from '@shared/utils'

const INVALID_CHARACTERS = /[<>:"/\\|?*]/gu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const MAX_FILE_NAME_BYTES = 255

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  let result = ''
  for (const character of value) {
    if (getUtf8ByteLength(result + character) > maximumBytes) break
    result += character
  }
  return result
}

export const sanitizeFileName = (originalName: string): string => {
  const withoutControlCharacters = [...originalName]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127) ? '_' : character
    })
    .join('')
  const replaced = withoutControlCharacters
    .replace(INVALID_CHARACTERS, '_')
    .replace(/[. ]+$/u, '')
    .trim()
  const fallback =
    replaced === '' || replaced === '.' || replaced === '..' ? 'received-file' : replaced
  const guarded = WINDOWS_RESERVED_NAME.test(fallback) ? `_${fallback}` : fallback
  if (getUtf8ByteLength(guarded) <= MAX_FILE_NAME_BYTES) return guarded

  const extension = extname(guarded)
  const extensionBytes = getUtf8ByteLength(extension)
  if (extensionBytes >= MAX_FILE_NAME_BYTES - 1) {
    return truncateUtf8(guarded, MAX_FILE_NAME_BYTES)
  }
  const stem = guarded.slice(0, guarded.length - extension.length)
  return `${truncateUtf8(stem, MAX_FILE_NAME_BYTES - extensionBytes)}${extension}`
}
