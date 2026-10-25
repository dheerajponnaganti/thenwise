// Dead ends found at ingest by fixed phrase rules, no model: a sentence that records a path being given up.
// The flag is automatic (extra.deadEnd), apart from curated dead_end notes, which only come from accepted proposals.
const STRONG = /\b(?:reverted|rolled back|gave up|did not work|didn'?t work|does not work anymore|made it worse|too slow|abandoned|not wanted)\b/i;
// Common in plain design talk ("use X instead of Y"), so they count only next to a past-attempt cue.
const WEAK = /\b(?:broke|dropped|went back to|replaced by|instead of)\b/i;
const CUE = /\b(?:originally|previously|at first|first attempt|first try|turned out|tried)\b/i;
/** Text with code, quotes and tables taken out: a phrase inside them does not record a decision. */
function prose(text) {
    return text
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .split('\n')
        .filter((l) => !/^\s*(?:>|\|)/.test(l))
        .join('\n');
}
/** The first sentence of `text` that records a dropped approach, or undefined. */
export function deadEnd(text) {
    for (const raw of prose(text).split(/(?<=[.!])\s+|\n+/)) {
        const s = raw.replace(/^[\s*#>-]+/, '').replace(/\s+/g, ' ').trim();
        if (s.length < 15 || s.length > 400 || s.endsWith('?'))
            continue;
        if (/^(?:if|when|whether|should|do not|don'?t|never|to|in case)\b/i.test(s))
            continue; // advice and conditions, not events
        if (/\b(?:can|could|may|might|will|would|should|to|be) (?:be )?(?:reverted|rolled back)\b/i.test(s))
            continue; // a future option, not an event
        if (STRONG.test(s) || (WEAK.test(s) && CUE.test(s)))
            return s.length > 160 ? `${s.slice(0, 157)}...` : s;
    }
    return undefined;
}
/** A commit: `Revert "..."` in the subject, else a phrase in the body. */
export const commitDeadEnd = (subject, body) => (/^Revert\b/.test(subject) ? subject : deadEnd(body));
