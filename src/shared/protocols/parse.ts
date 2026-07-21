import { protocolMessageSchema } from './schemas'
import type { ProtocolMessage } from './types'

export const parseProtocolMessage = (input: unknown): ProtocolMessage =>
  protocolMessageSchema.parse(input)
