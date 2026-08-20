import fs from 'node:fs'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export const MAX_RECENT_PAGES = 15

function normalizedUrl(value: string) {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  return url.href
}

export function addRecentPage(pages: readonly string[], url: string) {
  const normalized = normalizedUrl(url)
  return [normalized, ...pages.filter((page) => page !== normalized)].slice(0, MAX_RECENT_PAGES)
}

export function recentPageLabel(url: string, maximumLength = 72) {
  const label = normalizedUrl(url)
  return label.length <= maximumLength ? label : `${label.slice(0, maximumLength - 1)}…`
}

export function readRecentPages(statePath: string) {
  let source: string
  try {
    source = fs.readFileSync(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const parsed: unknown = JSON.parse(source)
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`Invalid recent pages state: ${statePath}`)
  }

  const pages: string[] = []
  for (const value of parsed) {
    try {
      const normalized = normalizedUrl(value)
      if (normalized !== value) throw new Error('Recent page URL is not normalized')
      if (!pages.includes(normalized)) pages.push(normalized)
    } catch {
      throw new Error(`Invalid recent pages state: ${statePath}`)
    }
  }
  return pages.slice(0, MAX_RECENT_PAGES)
}

export function writeRecentPages(statePath: string, pages: readonly string[]) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileAtomic.sync(statePath, `${JSON.stringify(pages, null, 2)}\n`)
}
