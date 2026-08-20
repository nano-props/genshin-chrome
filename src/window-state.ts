import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import * as v from 'valibot'
import writeFileAtomic from 'write-file-atomic'

const coordinateSchema = v.pipe(v.number(), v.safeInteger())
const dimensionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1))
const windowBoundsSchema = v.object({
  x: coordinateSchema,
  y: coordinateSchema,
  width: dimensionSchema,
  height: dimensionSchema,
})

export type WindowBounds = v.InferOutput<typeof windowBoundsSchema>

export const defaultWindowSize = {
  width: 960,
  height: 640,
}

export const minimumWindowWidth = 640

export function readWindowBounds(statePath: string): WindowBounds | null {
  let source: string
  try {
    source = fs.readFileSync(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  try {
    return v.parse(windowBoundsSchema, JSON.parse(source))
  } catch (error) {
    throw new Error(`Invalid window state: ${statePath}`, { cause: error })
  }
}

export function writeWindowBounds(statePath: string, bounds: WindowBounds) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileAtomic.sync(statePath, `${JSON.stringify(bounds, null, 2)}\n`)
}

export function trackWindowBounds(window: BrowserWindow, statePath: string, reportError: (error: unknown) => void) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const save = () => {
    try {
      writeWindowBounds(statePath, window.getNormalBounds())
    } catch (error) {
      reportError(error)
    }
  }
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 250)
  }

  window.on('move', scheduleSave)
  window.on('resize', scheduleSave)
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    save()
  })
  window.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
  })
}
