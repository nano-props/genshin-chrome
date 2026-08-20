export const configEditorChannels = {
  read: 'config-editor:read',
  save: 'config-editor:save',
  setDirty: 'config-editor:set-dirty',
  requestClose: 'config-editor:request-close',
} as const

export type ConfigSaveResult =
  | { ok: true }
  | { ok: false; error: string; reloadedSource?: undefined }
  | { ok: false; error: string; reloadedSource: string }

type ConfigEditorPath = { path: string; displayPath: string }

export type ConfigEditorReadResult =
  (ConfigEditorPath & { ok: true; source: string }) | (ConfigEditorPath & { ok: false; error: string })

export type ConfigEditorBridge = {
  read(): Promise<ConfigEditorReadResult>
  save(source: string, expectedSource: string): Promise<ConfigSaveResult>
  setDirty(dirty: boolean): void
  requestClose(): void
}
