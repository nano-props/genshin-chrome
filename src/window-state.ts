import fs from 'node:fs'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export type WindowSize = {
  width: number
  height: number
}

export const defaultWindowSize: WindowSize = {
  width: 960,
  height: 640,
}

function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function readWindowSize(statePath: string): WindowSize | null {
  let source: string
  try {
    source = fs.readFileSync(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const value = JSON.parse(source) as Partial<WindowSize>
  if (!isValidDimension(value.width) || !isValidDimension(value.height)) {
    throw new Error(`Invalid window state: ${statePath}`)
  }
  return { width: value.width, height: value.height }
}

export function writeWindowSize(statePath: string, size: WindowSize) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileAtomic.sync(statePath, `${JSON.stringify(size, null, 2)}\n`)
}
