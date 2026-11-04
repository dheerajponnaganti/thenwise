// How long ago a time was, in the words the briefs and the handoff use.
/** "20 min ago", "5 h ago", "3 days ago", from an ISO time; never negative (a clock that ran ahead reads 0 min). */
export function ago(iso, now = Date.now()) {
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
