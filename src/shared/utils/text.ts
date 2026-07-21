const textEncoder = new TextEncoder()

export const getUtf8ByteLength = (value: string): number => textEncoder.encode(value).byteLength
