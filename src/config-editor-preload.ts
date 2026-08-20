import { contextBridge, ipcRenderer } from 'electron'
import { configEditorChannels } from '#/config-editor-types.ts'
import type { ConfigEditorBridge, ConfigSaveResult } from '#/config-editor-types.ts'

const configEditor: ConfigEditorBridge = {
  read: () => ipcRenderer.invoke(configEditorChannels.read),
  save: (source: string, expectedSource: string) =>
    ipcRenderer.invoke(configEditorChannels.save, source, expectedSource) as Promise<ConfigSaveResult>,
  setDirty: (dirty: boolean) => ipcRenderer.send(configEditorChannels.setDirty, dirty),
  requestClose: () => ipcRenderer.send(configEditorChannels.requestClose),
}

contextBridge.exposeInMainWorld('configEditor', configEditor)
