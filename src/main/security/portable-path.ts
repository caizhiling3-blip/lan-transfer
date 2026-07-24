import { getUtf8ByteLength } from '@shared/utils'

const INVALID_CHARACTERS = /[<>:"/\\|?*]/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export const normalizePortablePathSegment = (value: string): string => {
  const normalized = value.normalize('NFC')
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.endsWith('.') ||
    normalized.endsWith(' ') ||
    INVALID_CHARACTERS.test(normalized) ||
    WINDOWS_RESERVED_NAME.test(normalized) ||
    hasControlCharacter ||
    getUtf8ByteLength(normalized) > 255
  ) {
    throw new Error('FOLDER_PATH_INVALID')
  }
  return normalized
}

export const createPortablePathCollisionKey = (segments: readonly string[]): string =>
  segments.map((segment) => segment.normalize('NFC').toLowerCase()).join('/')
