// The data model. Backends implement it; they never extend it silently.
export const SCHEMA_VERSION = 1;
export const NODE_TYPES = ['decision', 'finding', 'entity', 'rule', 'task', 'episode', 'note'];
export const STATUSES = ['inbox', 'active', 'superseded', 'archived', 'rejected'];
export const CONFIDENCES = ['observed', 'human', 'agent', 'imported'];
export const ORIGINS = ['local', 'web', 'import'];
export const EDGE_TYPES = ['about', 'supersedes', 'depends_on', 'contradicts', 'part_of', 'derived_from', 'mentions'];
/** Edge types written as front-matter lists; `mentions` come from body links. */
export const FRONT_MATTER_EDGES = EDGE_TYPES.filter((t) => t !== 'mentions');
export const SOURCE_KINDS = ['file', 'url', 'commit', 'command', 'node', 'human'];
export const ID_PREFIX = {
    decision: 'dec',
    finding: 'fnd',
    entity: 'ent',
    rule: 'rul',
    task: 'tsk',
    episode: 'epi',
    note: 'not',
};
