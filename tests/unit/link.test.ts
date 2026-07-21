import { describe, expect, it } from 'vitest'

import { classifyTextContent, isHttpUrl } from '@shared/utils'

describe('link classification', () => {
  it.each(['http://example.com', 'https://example.com/path?q=1', '  https://例子.测试  '])(
    'recognizes an HTTP(S) URL: %s',
    (value) => expect(isHttpUrl(value)).toBe(true),
  )

  it.each(['example.com', 'javascript:alert(1)', 'file:///tmp/example', 'ordinary text'])(
    'rejects a non-HTTP(S) URL: %s',
    (value) => expect(isHttpUrl(value)).toBe(false),
  )

  it('classifies only a complete HTTP(S) URL as a link', () => {
    expect(classifyTextContent('https://example.com')).toBe('link')
    expect(classifyTextContent('See https://example.com')).toBe('text')
  })
})
