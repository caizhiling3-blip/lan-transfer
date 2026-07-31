import { describe, expect, expectTypeOf, it } from 'vitest'

import { ERROR_CODES, ERROR_MESSAGES_ZH_CN, ERROR_RECOVERY_ADVICE_ZH_CN } from '@shared/errors'
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type IpcEventChannel,
  type IpcInvokeRequest,
  type IpcInvokeResponse,
} from '@shared/ipc'

describe('error codes', () => {
  it('has one Chinese message for every error code', () => {
    expect(Object.keys(ERROR_MESSAGES_ZH_CN).sort()).toEqual([...ERROR_CODES].sort())
    expect(Object.values(ERROR_MESSAGES_ZH_CN).every((message) => message.length > 0)).toBe(true)
    expect(Object.keys(ERROR_RECOVERY_ADVICE_ZH_CN).sort()).toEqual([...ERROR_CODES].sort())
    expect(
      Object.values(ERROR_RECOVERY_ADVICE_ZH_CN).every(({ suggestion }) => suggestion.length > 0),
    ).toBe(true)
  })
})

describe('IPC contracts', () => {
  it('contains no duplicate channels', () => {
    const allChannels = [...IPC_INVOKE_CHANNELS, ...IPC_EVENT_CHANNELS]
    expect(new Set(allChannels).size).toBe(allChannels.length)
  })

  it('keeps request, response, and event channel types narrow', () => {
    expectTypeOf<IpcInvokeRequest<'connection:connect'>>().toEqualTypeOf<{
      readonly host: string
      readonly port: number
    }>()
    expectTypeOf<IpcInvokeResponse<'clipboard:read-text'>>().toMatchTypeOf<
      | { readonly ok: true; readonly data: string }
      | { readonly ok: false; readonly error: { readonly code: string } }
    >()
    expectTypeOf<'settings:changed'>().toExtend<IpcEventChannel>()
  })
})
