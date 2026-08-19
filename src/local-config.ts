import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig, AppConfigSource } from '#/config-types.ts'

const defaultAppOptions = {
  session: {
    partition: 'persist:genshin-chrome',
    cache: true,
  },
  window: {
    width: 1280,
    height: 820,
    minWidth: 680,
    minHeight: 480,
    backgroundColor: '#f5f5f7',
  },
  browser: {
    allowedProtocols: ['http:', 'https:'],
    allowRunningInsecureContent: false,
    devToolsMode: 'detach',
    remoteDebuggingPort: 9222,
  },
  requests: {
    enabled: false,
    rewrite() {
      return null
    },
  },
} satisfies Omit<AppConfig, 'startUrl'>

const defaultConfigSource = `export default {
  startUrl: 'https://example.com',
  session: {
    partition: 'persist:genshin-chrome',
    cache: true,
  },
  window: {
    width: 1280,
    height: 820,
    minWidth: 680,
    minHeight: 480,
    backgroundColor: '#f5f5f7',
  },
  browser: {
    allowedProtocols: ['http:', 'https:'],
    allowRunningInsecureContent: false,
    devToolsMode: 'detach',
    remoteDebuggingPort: 9222,
  },
  requests: {
    enabled: false,
    rewrite() {
      return null
    },
  },
}
`

const esmPackageSource = `{
  "type": "module"
}
`

export type LocalConfigPaths = {
  directory: string
  config: string
  package: string
}

export function resolveAppConfig(source: unknown): AppConfig {
  if (!source || typeof source !== 'object' || !('startUrl' in source)) {
    throw new Error('config.js 必须配置 startUrl')
  }

  const config = source as AppConfigSource
  if (typeof config.startUrl !== 'string' || !config.startUrl.trim()) {
    throw new Error('config.js 的 startUrl 必须是非空字符串')
  }

  return {
    startUrl: config.startUrl,
    session: { ...defaultAppOptions.session, ...config.session },
    window: { ...defaultAppOptions.window, ...config.window },
    browser: { ...defaultAppOptions.browser, ...config.browser },
    requests: { ...defaultAppOptions.requests, ...config.requests },
  }
}

export function resolveLocalConfigPaths(
  configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
) {
  const directory = path.join(path.resolve(configHome), 'genshin-chrome')
  return {
    directory,
    config: path.join(directory, 'config.js'),
    package: path.join(directory, 'package.json'),
  }
}

export function ensureLocalConfig(paths = resolveLocalConfigPaths()) {
  fs.mkdirSync(paths.directory, { recursive: true })
  if (!fs.existsSync(paths.package)) fs.writeFileSync(paths.package, esmPackageSource)
  if (!fs.existsSync(paths.config)) fs.writeFileSync(paths.config, defaultConfigSource)
  return paths
}
