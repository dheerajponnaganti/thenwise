// Secret masking before any write (spec 06 §3 step 3, 08 §4). Patterns for common key formats plus
// "name = value" assignments of secret-looking names. Hosts may add their own detector on top.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bSK[0-9a-fA-F]{32}\b/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  // A key block cut short (the end line is in another message): mask the key text that is there.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})*/g,
]
// Prefixes with `_` or `-` only refuse a letter or digit before them, so `foo_ghp_...` is caught but
// `network_test_env` is not. Those characters are not base64, so images stay unmasked.
// A key wrapped at a line break: 16+ key characters to the line end, then continuation lines.
const WRAPPED = /(?<![A-Za-z0-9])(?=[A-Za-z0-9_.-]{16})(?:gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|[sr]k_(?:live|test)_|npm_|hf_|glpat-|AKIA|AIza|SK)[A-Za-z0-9_.-]*(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9_.-]+)+/g
// `curl -u user:pass`.
const CURL_USER = /((?:\s-u|\s--user)[\s=]+["']?[^\s:"']+:)([^\s"']{3,})/g
// The password in a URL: `postgres://user:pass@host` keeps the user and host.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi
// Upper-case env names ending in a secret word: `STRIPE_KEY=...`, `DB_PASSWORD=...`; Azure `AccountKey=...`.
const ENV = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)|AccountKey|SharedAccessKey)(\s*=\s*["']?)([^\s"';]{8,})/g
// The value after a secret-looking name: `api_key = abcd...`, `"password": "..."`, `Authorization: Bearer ...`.
// Longer names count too: `client_secret`, `access_token`, `aws_secret_access_key`. Plain whitespace separates only
// before `bearer`/`basic` (or after `Bearer` itself), so prose like "token expiration" keeps its words.
const ASSIGNED = /\b([\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|secret[_-]?access[_-]?key))\b(["']?\s*[:=]\s*["']?|\s+(?=(?:bearer|basic)\s)|(?<=(?<![\w-])bearer)\s+)((?:bearer|basic)\s+)?([^\s"',;]{8,})/gi

export const MASK = '[secret masked]'
/** Raise when the patterns change: the archive re-masks files masked by an older version. */
export const MASK_VERSION = 5

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text.replace(WRAPPED, (hit) => {
    const parts = hit.split(/([ \t]*\r?\n[ \t]*)/) // pieces and separators alternate
    const joined = parts.filter((_, i) => i % 2 === 0).join('')
    for (const p of PATTERNS) {
      const m = new RegExp(p.source, 'g').exec(joined)
      if (!m || m.index !== 0 || m[0].length <= parts[0]!.length) continue
      let used = 0
      let end = 0
      for (let i = 0; i < parts.length; i++) {
        end += parts[i]!.length
        if (i % 2 === 0 && (used += parts[i]!.length) >= m[0].length) break
      }
      count++

      return MASK + hit.slice(end)
    }

    return hit
  })
  for (const re of PATTERNS) out = out.replace(re, () => (count++, MASK))
  out = out.replace(URL_PASSWORD, (m, head: string, pass: string) => (pass === MASK ? m : (count++, `${head}${MASK}@`)))
  out = out.replace(CURL_USER, (m, head: string, pass: string) => (pass.startsWith('[secret') ? m : (count++, `${head}${MASK}`)))
  out = out.replace(ENV, (m, name: string, sep: string, value: string) => (value.startsWith('[secret') ? m : (count++, `${name}${sep}${MASK}`)))
  out = out.replace(ASSIGNED, (m, name: string, sep: string, bearer: string | undefined, value: string) => {
    if (/\(\)?$/.test(value) || value === MASK || value.startsWith('[secret') || value.startsWith('masked]')) return m
    count++

    return `${name}${sep}${bearer ?? ''}${MASK}`
  })

  return { text: out, count }
}

/** Masks every string inside parsed JSON. */
export const maskDeep = (v: unknown): unknown => {
  if (typeof v === 'string') return maskSecrets(v).text
  if (Array.isArray(v)) return v.map(maskDeep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]))

  return v
}
