import type { Workbench } from '#/browser-types.ts'

declare global {
  interface Window {
    workbench: Workbench
  }
}

export {}
