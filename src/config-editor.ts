import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { configEditorChannels } from '#/config-editor-types.ts'
import { commandShortcutKey } from '#/keyboard-shortcuts.ts'
import { readLocalConfigSource, saveLocalConfigSourceIfUnchanged } from '#/local-config.ts'
import type { LocalConfigPaths } from '#/local-config.ts'
import { readWindowBounds, trackWindowBounds } from '#/window-state.ts'

type ConfigEditorControllerOptions = {
  preloadPath: string
  rendererDirectory: string
  devServerUrl?: string
  configPaths: LocalConfigPaths
  windowStatePath: () => string
}

type ConfigEditorSession = {
  window: InstanceType<typeof BrowserWindow>
  readyToShow: boolean
  dirty: boolean
  closeConfirmed: boolean
  closePromptOpen: boolean
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const DEFAULT_CONFIG_EDITOR_SIZE = {
  width: 820,
  height: 640,
}

export function createConfigEditorController(options: ConfigEditorControllerOptions) {
  let session: ConfigEditorSession | null = null

  function clearWindowState(window: InstanceType<typeof BrowserWindow>) {
    if (session?.window === window) session = null
  }

  function sessionForSender(sender: Electron.WebContents) {
    if (!session || session.window.isDestroyed() || session.window.webContents !== sender) return null
    return session
  }

  function windowForSender(sender: Electron.WebContents) {
    const senderSession = sessionForSender(sender)
    if (!senderSession) throw new Error('配置编辑器请求来源无效')
    return senderSession.window
  }

  function loadEditor(window: InstanceType<typeof BrowserWindow>) {
    if (!options.devServerUrl) {
      return window.loadFile(path.join(options.rendererDirectory, 'config-editor.html'))
    }

    const serverUrl = options.devServerUrl.endsWith('/') ? options.devServerUrl : `${options.devServerUrl}/`
    return window.loadURL(new URL('config-editor.html', serverUrl).href)
  }

  ipcMain.handle(configEditorChannels.read, (event: Electron.IpcMainInvokeEvent) => {
    windowForSender(event.sender)
    try {
      return {
        ok: true,
        path: options.configPaths.config,
        source: readLocalConfigSource(options.configPaths),
      } as const
    } catch (error) {
      return {
        ok: false,
        path: options.configPaths.config,
        error: errorMessage(error),
      } as const
    }
  })

  ipcMain.handle(
    configEditorChannels.save,
    (event: Electron.IpcMainInvokeEvent, source: unknown, expectedSource: unknown) => {
      windowForSender(event.sender)
      try {
        if (typeof source !== 'string' || typeof expectedSource !== 'string') {
          throw new Error('配置编辑器保存参数无效')
        }
        const result = saveLocalConfigSourceIfUnchanged(source, expectedSource, options.configPaths)
        if (!result.ok) {
          return {
            ok: false,
            error: 'config.js 已被其他程序修改，已重新加载最新内容',
            reloadedSource: result.currentSource,
          } as const
        }
        return { ok: true } as const
      } catch (error) {
        return { ok: false, error: errorMessage(error) } as const
      }
    },
  )

  ipcMain.on(configEditorChannels.setDirty, (event: Electron.IpcMainEvent, dirty: unknown) => {
    const senderSession = sessionForSender(event.sender)
    if (senderSession) senderSession.dirty = dirty === true
  })

  ipcMain.on(configEditorChannels.requestClose, (event: Electron.IpcMainEvent) => {
    sessionForSender(event.sender)?.window.close()
  })

  return {
    async open() {
      if (session) {
        const existingWindow = session.window
        if (!existingWindow.isDestroyed()) {
          if (existingWindow.isMinimized()) existingWindow.restore()
          if (session.readyToShow) {
            existingWindow.show()
            existingWindow.focus()
          }
          return
        }
        clearWindowState(existingWindow)
      }

      const windowStatePath = options.windowStatePath()
      const initialBounds = readWindowBounds(windowStatePath) ?? DEFAULT_CONFIG_EDITOR_SIZE
      const window = new BrowserWindow({
        ...initialBounds,
        minWidth: 640,
        minHeight: 480,
        title: '配置编辑器',
        resizable: true,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        show: false,
        backgroundColor: '#f5f5f7',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 18, y: 11 },
        ...(process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      const currentSession: ConfigEditorSession = {
        window,
        readyToShow: false,
        dirty: false,
        closeConfirmed: false,
        closePromptOpen: false,
      }
      session = currentSession
      trackWindowBounds(window, windowStatePath, console.error)
      window.webContents.on('before-input-event', (event, input) => {
        if (commandShortcutKey(input) !== 'r') return
        event.preventDefault()
      })
      window.once('ready-to-show', () => {
        if (session !== currentSession || window.isDestroyed()) return
        currentSession.readyToShow = true
        window.show()
        window.focus()
      })
      window.webContents.once('render-process-gone', (_event, details) => {
        console.error(`[config-editor] Renderer process exited: ${details.reason}`)
        if (!window.isDestroyed()) window.destroy()
        clearWindowState(window)
      })
      window.on('close', (event) => {
        if (!currentSession.dirty || currentSession.closeConfirmed) return
        event.preventDefault()
        if (currentSession.closePromptOpen) return
        currentSession.closePromptOpen = true

        void (async () => {
          try {
            const { response } = await dialog.showMessageBox(window, {
              type: 'warning',
              buttons: ['继续编辑', '放弃更改'],
              defaultId: 0,
              cancelId: 0,
              title: '放弃未保存的更改？',
              message: '配置尚未保存',
              detail: '关闭窗口会丢失本次修改。',
            })
            if (response !== 1 || window.isDestroyed()) return
            currentSession.closeConfirmed = true
            window.close()
          } catch (error) {
            console.error(error)
          } finally {
            currentSession.closePromptOpen = false
          }
        })()
      })
      window.on('closed', () => clearWindowState(window))
      try {
        await loadEditor(window)
      } catch (error) {
        if (!window.isDestroyed()) window.destroy()
        clearWindowState(window)
        throw error
      }
    },
  }
}
