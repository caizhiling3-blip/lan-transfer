export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const classifyTextContent = (value: string): 'text' | 'link' =>
  isHttpUrl(value) ? 'link' : 'text'
