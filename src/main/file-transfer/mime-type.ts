import { extname } from 'node:path'

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

export const getMimeType = (filePath: string): string =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
