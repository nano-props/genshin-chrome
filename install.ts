#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ParseArgsConfig } from 'node:util'
import { parseArgs } from 'node:util'

const APP_NAME = 'Genshin Chrome'
const DESTINATION = path.join(os.homedir(), 'Applications')
const NPM_MIRROR_ELECTRON = 'https://npmmirror.com/mirrors/electron/'
const NPM_MIRROR_BINARIES = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const repoRoot = path.resolve(import.meta.dirname)
process.chdir(repoRoot)

const USAGE = `Usage: ./install.ts [options]

Fast-reinstall Genshin Chrome into ~/Applications. Defaults to the fast path;
pass --full to run typecheck before packaging.

  --clean                Clear electron / electron-builder caches before building.
  --npmmirror            Route electron + electron-builder-binaries downloads
                         through npmmirror.
  --mirror=URL           Electron download mirror (overrides --npmmirror).
  --binaries-mirror=URL  electron-builder-binaries mirror (overrides --npmmirror).
  --full                 Run typecheck before packaging.
  -h, --help             Show this help.

Mirror env vars take a URL; leave unset/empty to disable:
  ELECTRON_MIRROR, ELECTRON_BUILDER_BINARIES_MIRROR
`

const options = {
  clean: { type: 'boolean' as const },
  npmmirror: { type: 'boolean' as const },
  mirror: { type: 'string' as const },
  'binaries-mirror': { type: 'string' as const },
  full: { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' as const },
} satisfies ParseArgsConfig['options']

type Values = {
  clean?: boolean
  npmmirror?: boolean
  mirror?: string
  'binaries-mirror'?: string
  full?: boolean
  help?: boolean
}

let values: Values
try {
  values = parseArgs({ options, strict: true }).values as Values
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n\n${USAGE}`)
  process.exit(2)
}

if (values.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

if (process.platform !== 'darwin') {
  process.stderr.write('Genshin Chrome only supports macOS.\n')
  process.exit(1)
}

const environment: NodeJS.ProcessEnv = { ...process.env }
if (values.npmmirror) {
  environment.ELECTRON_MIRROR = NPM_MIRROR_ELECTRON
  environment.ELECTRON_BUILDER_BINARIES_MIRROR = NPM_MIRROR_BINARIES
}
if (values.mirror?.trim()) environment.ELECTRON_MIRROR = values.mirror.trim()
if (values['binaries-mirror']?.trim()) {
  environment.ELECTRON_BUILDER_BINARIES_MIRROR = values['binaries-mirror'].trim()
}

function run(command: string, args: string[], commandEnvironment = environment) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: commandEnvironment })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function isRunning() {
  return spawnSync('pgrep', ['-x', APP_NAME], { stdio: 'ignore' }).status === 0
}

const architecture = os.arch()
const appDirectoryCandidates =
  architecture === 'arm64' ? ['release/mac-arm64', 'release/mac'] : ['release/mac-x64', 'release/mac']

if (isRunning()) run('bash', ['close-app.sh'])

if (values.clean) {
  console.log('Cleaning electron caches...')
  rmSync(path.join(os.homedir(), 'Library/Caches/electron'), { force: true, recursive: true })
  rmSync(path.join(os.homedir(), 'Library/Caches/electron-builder'), { force: true, recursive: true })
}

console.log('Installing dependencies...')
run('bun', ['install'])

if (values.full) {
  console.log('Typechecking...')
  run('bun', ['run', 'typecheck'])
}

console.log('Building renderer...')
run('bun', ['run', 'build'])

console.log('Packaging...')
run('bunx', ['electron-builder', '--mac', '--dir'])

console.log(`Installing to ${DESTINATION}...`)
const appDirectory = appDirectoryCandidates.find((candidate) => existsSync(path.join(candidate, `${APP_NAME}.app`)))
if (!appDirectory) {
  console.error(`Error: packaged app not found for ${architecture}`)
  process.exit(1)
}

const packagedApp = path.join(appDirectory, `${APP_NAME}.app`)
run('codesign', ['--verify', '--deep', '--strict', packagedApp])

mkdirSync(DESTINATION, { recursive: true })
const installedApp = path.join(DESTINATION, `${APP_NAME}.app`)
rmSync(installedApp, { force: true, recursive: true })
cpSync(packagedApp, installedApp, { recursive: true })
console.log(`Installed: ${installedApp}`)

console.log('Cleaning build artifacts...')
rmSync('dist', { force: true, recursive: true })
rmSync('release', { force: true, recursive: true })
