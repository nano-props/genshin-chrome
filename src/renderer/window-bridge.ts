import type { Workbench } from '#/browser-types.ts'
import type { ConfigEditorBridge } from '#/config-editor-types.ts'

type WindowBridges = {
  workbench: Workbench
  configEditor: ConfigEditorBridge
}

export function requireWindowBridge<Name extends keyof WindowBridges>(name: Name) {
  const bridge = Reflect.get(window, name) as WindowBridges[Name] | undefined
  if (!bridge) throw new Error(`缺少 ${name} 窗口桥接`)
  return bridge
}
