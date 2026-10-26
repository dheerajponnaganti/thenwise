// Serves the Hub's built folder: files by content type, and index.html for a path without a dot (the app's own routes).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}
// A build tool puts a content hash in the file name (app.abc123.js, index-DiwrgTda.js): such a file never changes.
const HASHED = /[.-][A-Za-z0-9_-]{6,}\.\w+$/
export const CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"

export function serveConsole(root: string, parts: string[]): { type: string; body: Buffer; cache: string } | null {
  if (parts.some((p) => p === '..' || p === '.' || /[\\/\0]/.test(p))) return null
  const base = resolve(root)
  let file = resolve(base, ...parts)
  if (file !== base && !file.startsWith(base + sep)) return null
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (/\./.test(parts.at(-1) ?? '')) return null
    file = join(base, 'index.html')
  }
  const name = file.slice(base.length + 1)

  return { type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body: readFileSync(file), cache: name !== 'index.html' && HASHED.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache' }
}
