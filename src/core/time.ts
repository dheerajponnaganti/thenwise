// Reading dates people type, and how long ago a time was, in the words the briefs and the handoff use.

/** False when a string starts with a date that names no real day, such as 2026-13-45 or 2026-02-30 (Date.parse
 * rolls the second over to March 2). Anything else is left to Date.parse. */
export const realDay = (s: string) => {
  const d = /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0]
  const t = d ? Date.parse(`${d}T00:00:00Z`) : 0

  return !d || (!Number.isNaN(t) && new Date(t).toISOString().startsWith(d))
}
/** Date.parse, but NaN for a date that names no real day. */
export const dateMs = (s: string) => (realDay(s) ? Date.parse(s) : NaN)

/** "20 min ago", "5 h ago", "3 days ago", from an ISO time; never negative (a clock that ran ahead reads 0 min). */
export function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))

  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
