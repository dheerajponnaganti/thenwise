// Input checks for the team server: a bad value is a 400 with a code, never a guess.

import type { IncomingMessage } from 'node:http'

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** A whole number from a query value, within bounds; `dflt` when absent. */
export function clampInt(v: string | null, dflt: number, min: number, max: number, name: string): number {
  if (v === null || v === '') return dflt
  if (!/^-?\d+$/.test(v)) throw new HttpError(400, 'bad_request', `${name} must be a whole number`)
  const n = Number(v)
  if (n < min || n > max) throw new HttpError(400, 'bad_request', `${name} must be between ${min} and ${max}`)

  return n
}

/** A string field of a JSON body, at most `max` characters. */
export function str(body: Record<string, unknown>, key: string, max: number): string {
  const v = body[key]
  if (typeof v !== 'string') throw new HttpError(400, 'bad_request', `${key} must be text`)
  if (v.length > max) throw new HttpError(400, 'bad_request', `${key} is longer than ${max} characters`)

  return v
}

/** The request body as a JSON object, at most `max` bytes. */
export async function readBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const ch of req) {
    size += (ch as Buffer).length
    if (size > max) throw new HttpError(413, 'too_large', `the body is larger than ${max} bytes`)
    chunks.push(ch as Buffer)
  }
  let v: unknown
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_request', 'the body is not JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_request', 'the body must be a JSON object')

  return v as Record<string, unknown>
}

/** An If-Match header: a revision, or `*` for a note that must not exist yet. */
export function ifMatch(h: string | string[] | undefined): number | '*' {
  const v = (Array.isArray(h) ? h[0] : h)?.trim().replace(/^"|"$/g, '')
  if (v === '*') return '*'
  if (!v || !/^\d+$/.test(v)) throw new HttpError(400, 'bad_request', 'If-Match must be a revision number or *')

  return Number(v)
}

/** The client's own order of a change (a whole number, 0 when absent). */
export function seqOf(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'bad_request', 'seq must be a whole number')

  return n
}
