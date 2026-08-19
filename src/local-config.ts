import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
