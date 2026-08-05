import type { TransferResumeStateMessage } from '@shared/protocols'

type VerifiedRanges = TransferResumeStateMessage['payload']['files'][number]['verifiedRanges']

export const createVerifiedChunkRanges = (
  verifiedChunks: ReadonlyMap<number, string>,
  chunkCount: number,
): VerifiedRanges => {
  const indexes = [...verifiedChunks.keys()]
    .filter((index) => index < chunkCount)
    .sort((left, right) => left - right)
  const ranges: { start: number; end: number }[] = []
  for (const index of indexes) {
    const previous = ranges.at(-1)
    if (previous !== undefined && previous.end === index) previous.end += 1
    else ranges.push({ start: index, end: index + 1 })
  }
  return ranges
}

export const expandVerifiedChunkRanges = (
  ranges: VerifiedRanges,
  chunkCount: number,
): Set<number> => {
  const verified = new Set<number>()
  let previousEnd = 0
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < previousEnd ||
      range.start >= range.end ||
      range.end > chunkCount
    ) {
      throw new Error('RESUME_STATE_INVALID')
    }
    for (let index = range.start; index < range.end; index += 1) verified.add(index)
    previousEnd = range.end
  }
  return verified
}
