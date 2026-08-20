import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'acorn'
import type { Expression, Literal, ObjectExpression, Program, Property, VariableDeclaration } from 'acorn'
import type { AppConfig, AppConfigSource } from '#/config-types.ts'
import writeFileAtomic from 'write-file-atomic'

const defaultAppOptions = {
  session: {
    partition: 'persist:genshin-chrome',
    cache: true,
  },
  window: {
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
  startUrl: 'https://pai.mn/',
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

function mergeOptions<T extends object>(defaults: T, overrides?: Partial<T>): T {
  return { ...defaults, ...overrides }
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
    session: mergeOptions(defaultAppOptions.session, config.session),
    window: mergeOptions(defaultAppOptions.window, config.window),
    browser: mergeOptions(defaultAppOptions.browser, config.browser),
    requests: mergeOptions(defaultAppOptions.requests, config.requests),
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

export function readLocalConfigSource(paths = resolveLocalConfigPaths()) {
  return fs.readFileSync(paths.config, 'utf8')
}

type StaticConfig = { kind: 'object'; value?: ObjectExpression } | { kind: 'invalid' } | { kind: 'unknown' }

function declaredConfig(program: Program, name: string, visited: Set<string>): StaticConfig {
  const declarations: Array<{ kind: VariableDeclaration['kind']; value: Expression | null }> = []

  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === 'Identifier' && declaration.id.name === name) {
          declarations.push({ kind: statement.kind, value: declaration.init ?? null })
        }
      }
      continue
    }
    if (
      (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
      statement.id?.name === name
    ) {
      return { kind: 'unknown' }
    }
  }

  if (declarations.length !== 1 || declarations[0]?.kind !== 'const' || !declarations[0].value) {
    return { kind: 'unknown' }
  }
  if (visited.has(name)) return { kind: 'unknown' }
  visited.add(name)
  const config = staticConfig(declarations[0].value, program, visited)
  return config.kind === 'object' ? { kind: 'object' } : config
}

function staticConfig(expression: Expression, program: Program, visited = new Set<string>()): StaticConfig {
  if (expression.type === 'ObjectExpression') return { kind: 'object', value: expression }
  if (expression.type === 'Identifier') return declaredConfig(program, expression.name, visited)
  if (
    expression.type === 'ArrayExpression' ||
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'ClassExpression' ||
    expression.type === 'FunctionExpression' ||
    expression.type === 'Literal' ||
    expression.type === 'TemplateLiteral' ||
    expression.type === 'UnaryExpression'
  ) {
    return { kind: 'invalid' }
  }
  return { kind: 'unknown' }
}

function exportedConfig(program: Program): StaticConfig {
  const defaultExport = program.body.find((statement) => statement.type === 'ExportDefaultDeclaration')
  if (!defaultExport || defaultExport.type !== 'ExportDefaultDeclaration') {
    throw new Error('config.js 必须使用 export default 导出配置')
  }

  if (
    defaultExport.declaration.type === 'FunctionDeclaration' ||
    defaultExport.declaration.type === 'ClassDeclaration'
  ) {
    return { kind: 'invalid' }
  }
  return staticConfig(defaultExport.declaration, program)
}

function propertyName(property: Property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name
  if (property.key.type === 'Literal') return String(property.key.value)
  if (property.key.type === 'TemplateLiteral' && property.key.expressions.length === 0) {
    return property.key.quasis[0]?.value.cooked ?? ''
  }
  return undefined
}

type StaticString = { kind: 'string'; value: string } | { kind: 'invalid' } | { kind: 'unknown' }

function staticString(expression: Expression | Literal): StaticString {
  if (expression.type === 'Literal') {
    return typeof expression.value === 'string' ? { kind: 'string', value: expression.value } : { kind: 'invalid' }
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return { kind: 'string', value: expression.quasis[0]?.value.cooked ?? '' }
  }
  if (
    expression.type === 'ArrayExpression' ||
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'ClassExpression' ||
    expression.type === 'FunctionExpression' ||
    expression.type === 'ObjectExpression'
  ) {
    return { kind: 'invalid' }
  }
  return { kind: 'unknown' }
}

function validateStaticRequiredFields(config: ObjectExpression) {
  for (let index = config.properties.length - 1; index >= 0; index -= 1) {
    const property = config.properties[index]
    if (!property || property.type === 'SpreadElement') return

    const name = propertyName(property)
    if (name === undefined && property.computed) return
    if (name !== 'startUrl') continue
    if (property.kind !== 'init') return

    const value = staticString(property.value)
    if (value.kind === 'unknown') return
    if (value.kind === 'invalid' || !value.value.trim()) {
      throw new Error('config.js 的 startUrl 必须是非空字符串')
    }
    return
  }

  throw new Error('config.js 必须配置 startUrl')
}

export function validateLocalConfigSource(source: string) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const config = exportedConfig(program)
  if (config.kind === 'invalid') throw new Error('config.js 默认导出必须是对象')
  if (config.kind === 'object' && config.value) validateStaticRequiredFields(config.value)
}

export function saveLocalConfigSource(source: string, paths = resolveLocalConfigPaths()) {
  validateLocalConfigSource(source)
  writeFileAtomic.sync(paths.config, source)
}

export function saveLocalConfigSourceIfUnchanged(
  source: string,
  expectedSource: string,
  paths = resolveLocalConfigPaths(),
) {
  const currentSource = readLocalConfigSource(paths)
  if (currentSource !== expectedSource) return { ok: false, currentSource } as const
  saveLocalConfigSource(source, paths)
  return { ok: true } as const
}
