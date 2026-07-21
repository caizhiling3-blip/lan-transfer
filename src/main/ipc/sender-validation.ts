export interface IpcSenderContext {
  readonly senderId: number
  readonly senderFrame: object | null
  readonly mainFrame: object
}

export interface TrustedWindowContext {
  readonly destroyed: boolean
  readonly webContentsId: number
}

export const isTrustedIpcSenderContext = (
  sender: IpcSenderContext,
  window: TrustedWindowContext | null,
): boolean =>
  window !== null &&
  !window.destroyed &&
  sender.senderId === window.webContentsId &&
  sender.senderFrame === sender.mainFrame
