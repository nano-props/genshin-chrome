import { contextBridge, ipcRenderer } from 'electron'
import { browserChannels } from '#/browser-types.ts'
import type { BrowserAction, BrowserState, Workbench } from '#/browser-types.ts'

type Listener<T> = (payload: T) => void

function subscribe<T>(channel: string, listener: Listener<T>) {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const workbench: Workbench = {
  navigate: (url: string) => ipcRenderer.invoke(browserChannels.navigate, url),
  browserAction: (action: BrowserAction) => ipcRenderer.send(browserChannels.action, action),
  updateViewBounds: (bounds: Electron.Rectangle) => ipcRenderer.send(browserChannels.bounds, bounds),
  onEditAddress: (listener: () => void) => subscribe<void>(browserChannels.editAddress, listener),
  onBrowserState: (listener: Listener<BrowserState>) => subscribe(browserChannels.state, listener),
}

contextBridge.exposeInMainWorld('workbench', workbench)
