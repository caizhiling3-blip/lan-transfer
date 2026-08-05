import { describe, expect, it } from 'vitest'

import { createVerifiedChunkRanges, expandVerifiedChunkRanges } from '../../src/main/file-transfer'

describe('verified chunk ranges', () => {
  it('encodes sparse authenticated chunks into canonical half-open ranges', () => {
    expect(
      createVerifiedChunkRanges(
        new Map([
          [4, 'e'],
          [0, 'a'],
          [2, 'c'],
          [1, 'b'],
          [9, 'outside'],
        ]),
        5,
      ),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 5 },
    ])
  })

  it('expands canonical ranges without trusting peer ordering or bounds', () => {
    expect([...expandVerifiedChunkRanges([{ start: 1, end: 3 }], 4)]).toEqual([1, 2])
    expect(() =>
      expandVerifiedChunkRanges(
        [
          { start: 1, end: 3 },
          { start: 2, end: 4 },
        ],
        4,
      ),
    ).toThrow('RESUME_STATE_INVALID')
    expect(() => expandVerifiedChunkRanges([{ start: 3, end: 3 }], 4)).toThrow(
      'RESUME_STATE_INVALID',
    )
    expect(() => expandVerifiedChunkRanges([{ start: 0, end: 5 }], 4)).toThrow(
      'RESUME_STATE_INVALID',
    )
  })
})
