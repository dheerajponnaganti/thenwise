// The Phase C commands: search, why, tried, asof, trace, resume, path, get. Each prints a short header, then
// numbered results with kind, id, date, source and the part of the passage around the match. Pure functions: db in, text out.
import { endOf, GOOD, local, localDay, queryTerms } from "./engine.js";
const WHY = [/\bbecause\b/i, /\bso that\b/i, /\bsince\b/i, /\bthe reason\b/i, /\bwhy:/i, /\bdecision:/i, /\bso we\b/i, /\bto avoid\b/i, /\botherwise\b/i];
const TRIED = [/\btried\b/i, /didn'?t work/i, /\bfailed\b/i, /\bbroke\b/i, /\breverted?\b/i, /\bdead[- ]end\b/i, /\binstead\b/i, /\babandoned\b/i, /\bdropped\b/i, /\brolled back\b/i, /\bturned out\b/i, /\bwrong\b/i];
const STRONG = /\b(why|decision|dead-end):/i;
const UNDATED = new Set(['rule', 'doc', 'memory']); // no real date, so as-of cannot place them
// Curated notes (accepted decisions, rules, dead ends) carry real dates, even when their kind is rule.
const undated = (n) => UNDATED.has(n.kind) && !n.extra?.curated;
const ms = (at) => Date.parse(at);
/** A curated note is closed once its valid_to has passed (or it is superseded, when asking about now). */
const closed = (n, t, now = false) => !!n.extra?.curated && (n.until ? ms(n.until) <= t : now && n.extra.status === 'superseded');
const short = (id) => id.replace(/^(ses|turn|sum):(.{8}).*$/, '$1:$2');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);
const flat = (s) => s.replace(/\s+/g, ' ').trim();
function sourceOf(n) {
    if (n.kind === 'turn' || n.kind === 'summary')
        return `session ${short(n.source)} at ${local(n.at)}`;
    if (n.kind === 'pr')
        return `PR #${n.id.split('#').pop()} ${n.extra.url ?? n.source}${n.until ? `, merged ${n.until}` : `, ${n.extra.state ?? 'open'}`}`;
    if (n.kind === 'commit')
        return `commit ${n.id.split(':').pop().slice(0, 7)} in ${n.project}`;
    if (n.kind === 'session')
        return `session ${short(n.id)} ${local(n.at)} to ${local(n.until)}`;
    if (n.kind === 'section')
        return `${n.source}, section dated ${n.at}`;
    return n.source;
}
export function label(g, id) {
    const n = g.nodes.get(id);
    if (!n)
        return id;
    const d = localDay(n.at);
    if (n.kind === 'turn')
        return `turn on ${d} ("${cut(flat(n.title), 60)}")`;
    if (n.kind === 'summary')
        return `compaction summary on ${d}`;
    if (n.kind === 'session')
        return `session ${short(n.id)} (${d})`;
    if (n.kind === 'pr')
        return `PR #${n.id.split('#').pop()} "${cut(n.title, 60)}"`;
    if (n.kind === 'commit')
        return `commit ${n.id.split(':').pop().slice(0, 7)} "${cut(n.title, 60)}"`;
    if (n.kind === 'note')
        return `note "${n.title}"`;
    if (n.kind === 'file')
        return n.extra.aliases?.[0] ?? id.slice(5);
    return `${n.kind} ${cut(n.title || n.id, 60)}`;
}
const VERB = { derived_from: 'was derived from', supersedes: 'supersedes', touches: 'touches', changed: 'changed', read: 'read', edited: 'edited', ran_in: 'ran a command in', made: 'made', opened: 'opened', merged_as: 'was merged as', links_to: 'links to', continued_from: 'continues', mentions: 'mentions' };
export function sentence(g, src, dst, kind, extra) {
    const why = kind === 'mentions' && extra?.match ? ` (as "${extra.match}")` : '';
    return `${label(g, src)} ${VERB[kind] ?? kind} ${label(g, dst)}${why}`;
}
/** The part of a passage around its matches (the **highlights**, else the first of `keys`), about `max` characters. */
export function excerpt(text, max = 360, keys = []) {
    if (text.length <= max)
        return text;
    const lower = text.toLowerCase();
    let at = [...text.matchAll(/\*\*/g)].map((m) => m.index).filter((_, i) => i % 2 === 0);
    if (!at.length)
        at = keys.map((k) => lower.indexOf(k.toLowerCase())).filter((i) => i >= 0);
    // The window that holds the most matches, starting a little before the first of them.
    let start = 0;
    let most = -1;
    for (const p of at) {
        const s = Math.max(0, p - 80);
        const c = at.filter((q) => q >= s && q < s + max).length;
        if (c > most)
            (most = c, (start = s));
    }
    const sp = text.slice(start, start + 30).search(/\s/);
    if (start > 0 && sp >= 0)
        start += sp + 1;
    let end = Math.min(text.length, start + max);
    if (end < text.length)
        end = text.lastIndexOf(' ', end) > start ? text.lastIndexOf(' ', end) : end;
    return `${start > 0 ? '... ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' ...' : ''}`;
}
const quoted = (text) => text.split('\n').filter((l) => l.trim()).map((l) => `   | ${l}`).join('\n');
function result(i, h, extra = '') {
    const n = h.node;
    return `${i}. [${n.kind}] ${n.id}\n   date: ${local(n.at)}   project: ${h.project}   source: ${sourceOf(n)}   passage: ${h.pid.split('#').pop()}   found by: ${h.lanes.join('+')}${extra}\n${quoted(excerpt(h.shown))}`;
}
const CUT = 'passages are cut to the words around the match ("..."); get <id>#<passage> prints one in full';
function notRecorded(what, s) {
    const out = [`not recorded: nothing in the memory matches ${what}.`, ...rewording(s)];
    if (s.missing.length)
        out.push(`These words appear nowhere in it: ${s.missing.join(', ')}.`);
    if (s.hits.length)
        out.push('WARNING: the items below are only the closest by wording and are probably unrelated. Do not use them as an answer.', ...s.hits.slice(0, 2).map((h, i) => result(i + 1, h)));
    return out.join('\n');
}
/** Says what the search changed: synonyms it also searched, and spellings it corrected. */
const rewording = (s) => [...(s.expanded.length ? [`also searched: ${s.expanded.map((e) => `${e.to.join(', ')} (for ${e.from})`).join('; ')}`] : []), ...(s.fixed.length ? [`did you mean: ${s.fixed.map((f) => f.to).join(', ')} (for ${s.fixed.map((f) => f.from).join(', ')})`] : [])];
const head = (title, s, shown, total) => {
    const out = [`${title}: ${shown} of ${total} matching passages`, `searched: ${s.terms.join(' ') || '(exact references only)'}`];
    out.push(...rewording(s));
    if (s.missing.length)
        out.push(`no record of the word(s): ${s.missing.join(', ')}`);
    out.push(CUT);
    return out.join('\n');
};
export function search(g, q, limit = 6) {
    const s = g.search(q);
    if (!s.good.length)
        return notRecorded(`"${q}"`, s);
    return [head('search', s, Math.min(limit, s.good.length), s.good.length), '', ...s.good.slice(0, limit).map((h, i) => result(i + 1, h, i < 3 ? newerNote(s, h) : ''))].join('\n\n');
}
// How final a record is: a merged PR, a commit or a dated log entry is the outcome; chat is often the discussion before it.
const FINAL = { pr: 1.6, commit: 1.4, section: 1.4, rule: 1.3, note: 1.2, memory: 1.1, summary: 1, turn: 0.8 };
/** The most relevant newer record on the same topic, when there is one strong enough to matter. */
function newerOnTopic(s, h) {
    const top = Math.max(...s.good.map((x) => x.score));
    const at = ms(h.node.at);
    if (Number.isNaN(at) || undated(h.node))
        return undefined;
    // Same topic: it covers the query words about as well. The fused score alone would let an exact-title bonus hide it.
    // Rules, docs and memory files carry only a file time, so they never count as a newer record.
    return s.good.filter((x) => x.node.id !== h.node.id && !undated(x.node) && ms(x.node.at) > at && x.cov >= 0.75 * h.cov && x.score >= top / 3).sort((a, b) => b.score - a.score || (a.pid < b.pid ? -1 : 1))[0];
}
const newerNote = (s, h) => {
    const n = newerOnTopic(s, h);
    return n ? `\n   NEWER on this topic: ${n.node.kind} ${n.node.id} (${local(n.node.at)}); this one may be outdated: read the newer one (or run current) before saying what holds now` : '';
};
/** current: what holds now on a topic. Relevance, times how final the record is (PRs, commits and dated log entries
 * over chat), times how recent it is among the topic's matches. Each top result says when a newer record exists. */
export function current(g, topic, limit = 5) {
    const s = g.search(topic, { limit: 400, filter: (n) => !closed(n, Date.now(), true) });
    if (!s.good.length)
        return notRecorded(`"${topic}"`, s);
    const top = Math.max(...s.good.map((h) => h.score));
    const times = s.good.map((h) => ms(h.node.at)).filter((t) => !Number.isNaN(t));
    const t0 = Math.min(...times);
    const span = Math.max(...times) - t0 || 1;
    const scored = s.good
        .map((h) => {
        const t = ms(h.node.at);
        const recent = Number.isNaN(t) ? 0.5 : (t - t0) / span;
        // A record with a strong newer one on the same topic, at least as final, has probably been overtaken.
        const later = newerOnTopic(s, h);
        const overtaken = later && (FINAL[later.node.kind] ?? 1) >= (FINAL[h.node.kind] ?? 1) ? 0.6 : 1;
        return { h, v: (h.score / top) * (0.5 + h.cov) * (FINAL[h.node.kind] ?? 1) * (0.7 + 0.6 * recent) * overtaken };
    })
        .sort((a, b) => b.v - a.v || (a.h.pid < b.h.pid ? -1 : 1));
    const out = [
        head('current', s, Math.min(limit, scored.length), scored.length),
        'ranked for what holds now: final records (PRs, commits, dated log entries) and newer ones first; earlier chat may describe a plan that changed',
    ];
    return [out.join('\n'), '', ...scored.slice(0, limit).map((x, i) => result(i + 1, x.h, i < 3 ? newerNote(s, x.h) : ''))].join('\n\n');
}
/** why and tried: the topic's best passages, boosted when they state a reason or an attempt. Relevance leads; markers only
 * reorder close calls, so a plain commit message that holds the answer is not thrown away. */
function marked(g, name, topic, markers, limit = 5) {
    const s = g.search(topic, { limit: 400 });
    if (!s.good.length)
        return notRecorded(`${name} for "${topic}"`, s);
    const top = Math.max(...s.good.map((h) => h.score));
    const scored = s.good
        .map((h) => {
        const m = markers.filter((r) => r.test(h.text)).length + (STRONG.test(h.text) ? 1 : 0);
        return { h, m, v: (h.score / top) * (0.5 + h.cov) * (1 + 0.4 * Math.min(m, 3)) };
    })
        .sort((a, b) => b.v - a.v || (a.h.pid < b.h.pid ? -1 : 1));
    return [head(name, s, Math.min(limit, scored.length), scored.length), '', ...scored.slice(0, limit).map((x, i) => result(i + 1, x.h, `   markers: ${x.m}${i < 3 ? newerNote(s, x.h) : ''}`))].join('\n\n');
}
export const why = (g, topic) => marked(g, 'why', topic, WHY);
export const tried = (g, topic) => marked(g, 'tried', topic, TRIED);
/** Earliest later item that replaces `n`: a later PR or commit on the same files, or a later note on the same topic. */
function replacedBy(g, h, q) {
    const n = h.node;
    let best;
    const consider = (c, via) => {
        if (c && c.id !== n.id && ms(c.at) > ms(n.at) && (!best || ms(c.at) < ms(best.node.at)))
            best = { node: c, via };
    };
    if (n.kind === 'pr' || n.kind === 'commit') {
        for (const e of g.neighbours(n.id)) {
            if (g.nodes.get(e.to)?.kind !== 'file')
                continue;
            for (const f of g.neighbours(e.to))
                if (['pr', 'commit'].includes(g.nodes.get(f.to)?.kind ?? ''))
                    consider(g.nodes.get(f.to), `the same file ${label(g, e.to)}`);
        }
    }
    else if (n.kind === 'note') {
        for (const c of g.search(q, { filter: (x) => x.kind === 'note' }).good)
            consider(c.node, 'the same topic');
    }
    return best ? `later on ${best.via}: ${label(g, best.node.id)} (${best.node.at})` : undefined;
}
export function asof(g, date, q, limit = 5) {
    const end = ms(endOf(date));
    if (Number.isNaN(end))
        return `asof needs an ISO date first, such as 2026-10-19; got "${date}".`;
    const s = g.search(q, { filter: (n) => !undated(n) && ms(n.at) <= end && !closed(n, end), limit: 100 });
    if (!s.good.length)
        return notRecorded(`"${q}" on or before ${date}`, s);
    const top = s.good.slice(0, 12).sort((a, b) => ms(b.node.at) - ms(a.node.at) || (a.pid < b.pid ? -1 : 1)).slice(0, limit);
    const out = [`asof ${date}: ${top.length} of ${s.good.length} matching passages dated on or before ${date}, newest first`, `searched: ${s.terms.join(' ')}`, 'rules and memory files are undated and left out', CUT, `current at ${date}: ${label(g, top[0].node.id)} (${local(top[0].node.at)})`];
    const repos = commitsAt(g, end);
    if (repos.length)
        out.push(`the code as it was on ${date} (the newest commit on or before it; read a file with git show <sha>:<path>):`, ...repos);
    const blocks = top.map((h, i) => {
        const later = i < 3 ? replacedBy(g, h, q) : undefined;
        return result(i + 1, h, later ? `\n   ${later}` : '');
    });
    return [out.join('\n'), '', ...blocks].join('\n\n');
}
/** The newest commit on or before `end` in each repository, so a file can be read as it was then. */
function commitsAt(g, end) {
    const best = new Map();
    for (const n of g.nodes.values()) {
        if (n.kind !== 'commit' || !(ms(n.at) <= end) || !g.inScope(n))
            continue;
        const b = best.get(n.source);
        if (!b || ms(n.at) > ms(b.at))
            best.set(n.source, n);
    }
    return [...best.values()].sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4).map((n) => `- ${n.project}: ${label(g, n.id)}, ${local(n.at)}: git -C ${n.source} show ${String(n.extra.sha ?? n.id.split(':').pop()).slice(0, 7)}:<path>`);
}
function pick(g, id, keys) {
    const ps = g.passages(id);
    return ps.find((p) => keys.some((k) => k && p.text.toLowerCase().includes(k.toLowerCase()))) ?? ps[0];
}
export function trace(g, target, cap = 15) {
    const ex = g.exact(target);
    if (!ex.length) {
        const s = g.search(target);
        if (!s.good.length)
            return notRecorded(`"${target}"`, s);
        const hits = s.good.slice(0, 8).sort((a, b) => ms(b.node.at) - ms(a.node.at));
        return [`trace "${target}": no file, PR, commit or note by that name; showing ${hits.length} topic matches, newest first, grouped by date`, `searched: ${s.terms.join(' ')}`, ...grouped(hits.map((h) => ({ date: h.node.at, text: result(0, h).replace(/^0\. /, '- ') })))].join('\n\n');
    }
    const out = [`trace "${target}": ${ex.map((e) => `${e.why} -> ${label(g, e.id)}`).join('; ')}`, CUT];
    const items = [];
    for (const { id } of ex.slice(0, 3)) {
        const t = g.nodes.get(id);
        const keys = [id.split('#').pop(), id.split(':').pop().slice(0, 7), t.title, ...(t.extra.aliases ?? [])].filter((k) => k.length >= 3);
        const seen = new Set([id]);
        const nb = (g.adj.get(id) ?? []).filter((e) => e.kind !== 'part_of' && !g.isHub(e.to) && g.inScope(g.nodes.get(e.to)) && !seen.has(e.to) && seen.add(e.to)).sort((a, b) => ms(g.nodes.get(b.to).at) - ms(g.nodes.get(a.to).at) || (a.to < b.to ? -1 : 1));
        if (nb.length > cap)
            out.push(`${label(g, id)} is linked to ${nb.length} items; the newest ${cap} are shown.`);
        const own = pick(g, id, []);
        if (own)
            items.push({ date: t.at, text: `- [${t.kind}] ${id} (the target itself)\n   date: ${local(t.at)}   project: ${g.projectName(t)}   source: ${sourceOf(t)}\n${quoted(excerpt(own.text, 500))}` });
        for (const e of nb.slice(0, cap)) {
            const n = g.nodes.get(e.to);
            const p = pick(g, e.to, keys);
            const rel = e.out ? sentence(g, id, e.to, e.kind, e.extra) : sentence(g, e.to, id, e.kind, e.extra);
            items.push({ date: n.at, text: `- [${n.kind}] ${n.id}\n   date: ${local(n.at)}   project: ${g.projectName(n)}   source: ${sourceOf(n)}\n   link: ${rel}${p ? `\n${quoted(excerpt(p.text, 300, keys))}` : ''}` });
        }
    }
    items.sort((a, b) => ms(b.date) - ms(a.date));
    return [...out, ...grouped(items)].join('\n\n');
}
function grouped(items) {
    const out = [];
    let last = '';
    for (const it of [...items].sort((a, b) => ms(b.date) - ms(a.date))) {
        const d = it.date ? localDay(it.date) : 'undated';
        if (d !== last)
            (out.push(`== ${d} ==`), (last = d));
        out.push(it.text);
    }
    return out;
}
export function resume(g, q = '') {
    const terms = queryTerms(q);
    const sessions = [...g.nodes.values()].filter((n) => n.kind === 'session' && g.inScope(n));
    let ses;
    let how = 'the newest session';
    const key = words(q).join('-');
    if (key) {
        const byProject = sessions.filter((n) => n.project.toLowerCase().includes(key)).sort((a, b) => ms(b.until || b.at) - ms(a.until || a.at));
        if (byProject[0])
            (ses = byProject[0], (how = `the newest session of project "${q}"`));
        else {
            const score = new Map();
            const s = g.search(q, { filter: (n) => n.kind === 'turn' || n.kind === 'summary' });
            for (const h of s.good)
                score.set(h.node.source, (score.get(h.node.source) ?? 0) + h.score);
            const best = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
            if (best)
                (ses = g.nodes.get(best[0]), (how = `the session whose turns match "${q}" best`));
            else
                return notRecorded(`"${q}" in any session`, s);
        }
    }
    else
        ses = sessions.sort((a, b) => ms(b.until || b.at) - ms(a.until || a.at))[0];
    if (!ses)
        return 'not recorded: the graph holds no sessions.';
    const out = [`resume${q ? ` "${q}"` : ''}: ${how}: ${label(g, ses.id)}, ${ses.at} to ${ses.until}`];
    const kids = [...g.nodes.values()].filter((n) => n.source === ses.id && (n.kind === 'turn' || n.kind === 'summary')).sort((a, b) => ms(b.at) - ms(a.at) || (a.id < b.id ? -1 : 1));
    const sum = kids.find((n) => n.kind === 'summary');
    const turns = kids.filter((n) => n.kind === 'turn').slice(0, 3);
    const lastAt = kids[0]?.at ?? ses.until;
    if (sum) {
        const ps = g.passages(sum.id);
        out.push(`## Last compaction summary (${sum.at}, ${sum.id}), ${ps.length} passages, the last one shown\n${ps[ps.length - 1]?.text ?? ''}`);
    }
    else
        out.push('## Last compaction summary\nnone recorded for this session');
    out.push(`## Last ${turns.length} turns of the session, newest first`, ...turns.map((t) => {
        const ps = g.passages(t.id);
        return `- ${t.at}  ${t.id}\n   prompt: ${cut(flat(g.fullText(t.id).split('\n\n')[0] ?? ''), 300)}\n   last reply passage:\n${(ps[ps.length - 1]?.text ?? '').split('\n').map((l) => `   | ${l}`).join('\n')}`;
    }));
    const lower = (n) => `${n.title}\n${g.fullText(n.id)}`.toLowerCase();
    const on = (n) => !terms.length || terms.some((t) => lower(n).includes(t));
    const prs = [...g.nodes.values()].filter((n) => n.kind === 'pr' && g.inScope(n) && n.extra.state === 'OPEN' && on(n)).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 8);
    out.push(`## Open PRs${prs.length ? '' : ': none recorded'}`, ...prs.map((n) => `- ${label(g, n.id)}, opened ${n.at}, ${n.extra.url}\n   ${cut(flat(g.passages(n.id)[0]?.text ?? ''), 400)}`));
    const cwd = String(ses.extra.cwd ?? '');
    const commits = [...g.nodes.values()].filter((n) => n.kind === 'commit' && g.inScope(n) && ms(n.at) > ms(lastAt) && (cwd.includes(n.project) || on(n))).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 10);
    out.push(`## Commits after the last turn (${lastAt})${commits.length ? '' : ': none recorded'}`, ...commits.map((n) => `- ${label(g, n.id)}, ${n.at}`));
    const notes = (terms.length ? g.search(q, { filter: (n) => n.kind === 'note' }).good.map((h) => h.node) : [...g.nodes.values()].filter((n) => n.kind === 'note' && g.inScope(n))).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4);
    out.push(`## Newest matching vault notes${notes.length ? '' : ': none recorded'}`, ...notes.map((n) => `- ${label(g, n.id)}, ${n.at}, ${n.source}\n   ${cut(flat(g.passages(n.id)[0]?.text ?? ''), 500)}`));
    // Where the work stands is often in the release history and the "next to build" line, whatever the query words.
    const releases = [...g.nodes.values()].filter((n) => g.inScope(n) && ((n.kind === 'commit' && /^(\w[\w-]* )?v?\d+\.\d+\.\d+\b/.test(n.title)) || (n.kind === 'pr' && /^release v?\d+\.\d+/i.test(n.title)))).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4);
    out.push(`## Latest releases${releases.length ? '' : ': none recorded'}`, ...releases.map((n) => `- ${label(g, n.id)}, ${local(n.at)}`));
    const next = [...g.nodes.values()].filter((n) => (n.kind === 'note' || n.kind === 'section') && /pending|home/i.test(n.id)).flatMap((n) => g.fullText(n.id).split('\n').filter((l) => /next to build|\*\*next\b|^\s*[-*]\s+\[ \]\s+\*\*first/i.test(l)).map((l) => `- ${cut(l.trim(), 400)} (${label(g, n.id)})`));
    out.push(`## Next on the build list${next.length ? '' : ': none recorded'}`, ...[...new Set(next)].slice(0, 6));
    for (const n of [...g.nodes.values()].filter((x) => x.kind === 'note' && /pending/i.test(x.id) && on(x)).slice(0, 2)) {
        const open = g.fullText(n.id).split('\n').filter((l) => /^\s*[-*]\s+\[ \]/.test(l));
        out.push(`## Unchecked items in ${label(g, n.id)} (${n.at})`, open.length ? open.join('\n') : 'none unchecked');
    }
    const since = [lastAt, ...notes.map((n) => n.at)].sort().pop();
    out.push(`## Check against the repo (this output only knows what was recorded up to ${since})`, `- working directory of the session: ${cwd || 'unknown'}`, '- current branch: `git branch --show-current`, and compare with the branch named in the notes or PRs above', '- uncommitted changes: `git status --short`', `- commits after ${since}: \`git log --since=${since.slice(0, 10)} --oneline\``, '- open PRs still open: `gh pr list`; the PRs above may have merged since', '- trust the repo over any note above when they disagree');
    return out.join('\n\n');
}
/** Up to three shortest paths of at most four hops, found one at a time with the used middle nodes removed. */
export function path(g, a, b, max = 4) {
    const resolve = (q) => g.exact(q)[0]?.id ?? g.nodes.get(q)?.id ?? g.search(q).good[0]?.node.id;
    const from = resolve(a);
    const to = resolve(b);
    if (!from || !to)
        return `not recorded: could not resolve ${!from ? `"${a}"` : `"${b}"`} to anything in the memory.`;
    if (from === to)
        return `both resolve to ${label(g, from)}`;
    const banned = new Set();
    const found = [];
    for (let round = 0; round < 3; round++) {
        const prev = new Map();
        prev.set(from, { id: '', e: null });
        let frontier = [from];
        for (let d = 0; d < max && !prev.has(to) && frontier.length; d++) {
            const next = [];
            for (const cur of frontier) {
                for (const e of g.neighbours(cur)) {
                    if (prev.has(e.to) || (banned.has(e.to) && e.to !== to))
                        continue;
                    prev.set(e.to, { id: cur, e });
                    next.push(e.to);
                }
            }
            frontier = next;
        }
        if (!prev.has(to))
            break;
        const p = [];
        for (let c = to;; c = prev.get(c).id) {
            p.unshift({ id: c, e: prev.get(c).e });
            if (c === from)
                break;
        }
        found.push(p);
        for (const s of p.slice(1, -1))
            banned.add(s.id);
        if (p.length === 2)
            break; // a direct edge cannot be found twice
    }
    if (!found.length)
        return `path "${a}" to "${b}": no connection of at most ${max} hops that avoids hub nodes (part_of fan-out, files touched by more than 30 nodes).`;
    const out = [`path: ${label(g, from)} to ${label(g, to)}: ${found.length} path${found.length > 1 ? 's' : ''}, hubs avoided`];
    found.forEach((p, i) => {
        out.push(`path ${i + 1} (${p.length - 1} hop${p.length > 2 ? 's' : ''})`);
        for (let k = 1; k < p.length; k++) {
            const e = p[k].e;
            const [s, d] = e.out ? [p[k - 1].id, p[k].id] : [p[k].id, p[k - 1].id];
            out.push(`  ${k}. ${sentence(g, s, d, e.kind, e.extra)}`);
        }
    });
    return out.join('\n');
}
export function get(g, id) {
    const p = /^(.*)#p(\d+)$/.exec(id);
    const nid = p && g.nodes.has(p[1]) ? p[1] : id;
    const n = g.nodes.get(nid);
    if (!n) {
        const near = [...g.nodes.keys()].filter((k) => k.includes(id)).slice(0, 5);
        return `not recorded: no node with id "${id}".${near.length ? `\nIds containing it: ${near.join(', ')}` : ''}`;
    }
    const text = p && nid !== id ? g.passages(nid).find((x) => x.n === Number(p[2]))?.text : g.fullText(nid);
    const edges = (g.adj.get(nid) ?? []).filter((e) => e.kind !== 'part_of').slice(0, 15).map((e) => `  ${e.out ? sentence(g, nid, e.to, e.kind, e.extra) : sentence(g, e.to, nid, e.kind, e.extra)}`);
    return [`[${n.kind}] ${id}\ndate: ${local(n.at)}   project: ${g.projectName(n)}   source: ${sourceOf(n)}\ntitle: ${n.title}`, text ?? `not recorded: ${id} has no such passage`, edges.length ? `links (first ${edges.length}):\n${edges.join('\n')}` : ''].filter(Boolean).join('\n\n');
}
const words = (q) => q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export { GOOD };
