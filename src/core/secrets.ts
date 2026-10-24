// Secret masking before any write (spec 06 §3 step 3, 08 §4). Patterns for common key formats plus
// "name = value" assignments of secret-looking names. Hosts may add their own detector on top.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // A key block cut short (the end line is in another message): mask the key text that is there.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})*/g,
]
// `curl -u user:pass`.
const CURL_USER = /((?:\s-u|\s--user)[\s=]+["']?[^\s:"']+:)([^\s"']{3,})/g
// The password in a URL: `postgres://user:pass@host` keeps the user and host.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi
// Upper-case env names ending in a secret word: `STRIPE_KEY=...`, `DB_PASSWORD=...`; Azure `AccountKey=...`.
const ENV = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)|AccountKey|SharedAccessKey)(\s*=\s*["']?)([^\s"';]{8,})/g
// The value after a secret-looking name: `api_key = abcd...`, `"password": "..."`, `Authorization: Bearer ...`.
// Longer names count too: `client_secret`, `access_token`, `aws_secret_access_key`.
const ASSIGNED = /\b([\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|secret[_-]?access[_-]?key))\b(["']?\s*[:=]\s*["']?|\s+)((?:bearer|basic)\s+)?([^\s"',;]{8,})/gi

export const MASK = '[secret masked]'
/** Raise when the patterns change: the archive re-masks files masked by an older version. */
export const MASK_VERSION = 3

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const re of PATTERNS) out = out.replace(re, () => (count++, MASK))
  out = out.replace(URL_PASSWORD, (m, head: string, pass: string) => (pass === MASK ? m : (count++, `${head}${MASK}@`)))
  out = out.replace(CURL_USER, (m, head: string, pass: string) => (pass.startsWith('[secret') ? m : (count++, `${head}${MASK}`)))
  out = out.replace(ENV, (m, name: string, sep: string, value: string) => (value.startsWith('[secret') ? m : (count++, `${name}${sep}${MASK}`)))
  out = out.replace(ASSIGNED, (m, name: string, sep: string, bearer: string | undefined, value: string) => {
    if (value === MASK || value.startsWith('[secret') || value.startsWith('masked]')) return m
    count++

    return `${name}${sep}${bearer ?? ''}${MASK}`
  })

  return { text: out, count }
}
