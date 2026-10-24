// Episodes (spec 02 §6, 06 §2): one agent job, recorded from what the host observed. Never the agent's words.
import { SCHEMA_VERSION } from "./model.js";
export const noFacts = () => ({ title: '', stepsDone: 0, stepsTotal: 0, filesWritten: [], urlsFetched: [], commands: [], commits: [], outcome: 'answer' });
/** Jobs that changed nothing, fetched nothing and committed nothing are not recorded (noise rule). */
export const isWorthRecording = (f) => f.filesWritten.length > 0 || f.urlsFetched.length > 0 || f.commits.length > 0;
const MAX_NAMES = 5;
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const names = (list) => {
    const uniq = [...new Set(list)];
    return uniq.slice(0, MAX_NAMES).join(', ') + (uniq.length > MAX_NAMES ? ` +${uniq.length - MAX_NAMES} more` : '');
};
/**
 * The human line, in Logbook Phase 1's proven format:
 * `- 14:32 · Fix the login · 3 of 3 steps · changed: a.ts · fetched: 2 pages · checks: npm test passed · commit a1b2c3d · observed`
 */
export function episodeLine(time, f) {
    const parts = [time, oneLine(f.title).slice(0, 80) || 'Work'];
    if (f.stepsTotal > 0)
        parts.push(`${f.stepsDone} of ${f.stepsTotal} steps`);
    if (f.filesWritten.length > 0)
        parts.push(`changed: ${names(f.filesWritten)}`);
    const pages = new Set(f.urlsFetched).size;
    if (pages > 0)
        parts.push(`fetched: ${pages} page${pages === 1 ? '' : 's'}`);
    // The last run of each check command is its result; at most two are named.
    const last = new Map(f.commands.filter(c => c.isCheck).map(c => [oneLine(c.cmd).slice(0, 40), c.exitCode === 0]));
    const checks = [...last].slice(-2).map(([c, ok]) => `${c} ${ok ? 'passed' : 'failed'}`);
    if (checks.length > 0)
        parts.push(`checks: ${checks.join(', ')}`);
    if (f.commits.length > 0)
        parts.push(`commit ${[...new Set(f.commits)].join(', ')}`);
    if (f.outcome !== 'answer')
        parts.push(f.outcome);
    parts.push('observed');
    return `- ${parts.join(' · ')}`;
}
/** The machine record: one event line for the session's JSONL change log (spec 02 §7). */
export function episodeEvent(ep, eventId) {
    return JSON.stringify({ id: eventId, at: ep.endedAt, actor: ep.agentId, op: 'episode.put', target: ep.id, payload: ep, idempotency_key: ep.id, schema_version: SCHEMA_VERSION });
}
/** A session id made safe for a file name. */
export const sessionFileName = (sessionId) => sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'session';
/** Adds `line` as the newest bullet of a session's day log, creating the file's heading if needed. */
export function insertEpisodeLine(text, heading, line) {
    if (text.trim() === '')
        return `# ${heading}\n\n${line}\n`;
    const lines = text.split('\n');
    const first = lines.findIndex(l => l.startsWith('- '));
    if (first >= 0)
        lines.splice(first, 0, line);
    else {
        const body = text.replace(/\n*$/, '');
        return `${body}\n\n${line}\n`;
    }
    return lines.join('\n');
}
