import type { BrowserWindow } from 'electron'
import type { AppEvent } from '@shared/types'

let getWindows: (() => BrowserWindow[]) | undefined

export function setEventWindowProvider(provider: () => BrowserWindow[]): void {
  getWindows = provider
}

export function emitEvent(event: AppEvent): void {
  const targets = getWindows?.() ?? []
  for (const window of targets) {
    if (!window.isDestroyed()) window.webContents.send('app:event', event)
  }
}
