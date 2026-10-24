import { createHash } from 'node:crypto'

/** Bearer tokens are only ever stored and compared as the SHA-256 hex of their text. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
