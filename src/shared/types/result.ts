import type { AppError } from '../errors'

export type OperationResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: AppError }
