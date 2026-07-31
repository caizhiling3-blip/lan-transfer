import log from 'electron-log/main'

export { LogLifecycle } from './log-lifecycle'

export type LogContext = Readonly<Record<string, unknown>>

export const initializeLogger = (): void => {
  log.initialize()
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1_024 * 1_024
  log.transports.console.level = process.env.NODE_ENV === 'production' ? 'warn' : 'info'
}

export const getActiveLogFilePath = (): string => log.transports.file.getFile().path

export const logger = {
  info(event: string, context: LogContext = {}): void {
    log.info(event, context)
  },
  warn(event: string, context: LogContext = {}): void {
    log.warn(event, context)
  },
  error(event: string, error: unknown, context: LogContext = {}): void {
    const errorDetails =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) }
    log.error(event, context, errorDetails)
  },
}
