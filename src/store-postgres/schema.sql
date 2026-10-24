-- Postgres schema, version 1 (spec 04 §4). Applied once by migrate.ts as migration 0001_init; safe to run again.
-- Every table carries scope_kind and scope_key. Ids are unique per scope, so one database can hold many scopes.

create extension if not exists pg_trgm;

create table if not exists scopes (
  scope_kind text not null,
  scope_key text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  primary key (scope_kind, scope_key)
);

create table if not exists nodes (
  scope_kind text not null,
  scope_key text not null,
  id text not null,
  type text not null check (type in ('decision', 'finding', 'entity', 'rule', 'task', 'episode', 'note')),
  -- Where the note lives in a vault (or would live in an export). Needed so links resolve by file name.
  path text not null default '',
  title text not null,
  summary text not null default '',
  body text not null default '',
  aliases jsonb not null default '[]',
  tags jsonb not null default '[]',
  headings jsonb not null default '[]',
  -- Raw link targets per edge type, unresolved; edges are derived from them.
  links jsonb not null default '[]',
  status text not null check (status in ('inbox', 'active', 'superseded', 'archived', 'rejected')),
  confidence text not null check (confidence in ('observed', 'human', 'agent', 'imported')),
  origin text not null check (origin in ('local', 'web', 'import')),
  -- Null when the source text is not a date. The exact source text is kept in extra.raw.
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz,
  updated_at timestamptz,
  version integer not null default 1,
  author text not null default '',
  paths jsonb not null default '[]',
  urls jsonb not null default '[]',
  done boolean,
  due text,
  -- Unknown and bookkeeping fields: raw times, parser issues, hasFrontMatter, bodyLines (02 §9).
  extra jsonb not null default '{}',
  -- Not BM25: ts_rank_cd over weighted fields. Body is cut at 400k characters (tsvector limit is 1 MB).
  tsv tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', aliases::text), 'A') ||
    setweight(to_tsvector('english', summary), 'B') ||
    setweight(to_tsvector('english', headings::text), 'C') ||
    setweight(to_tsvector('english', left(body, 400000)), 'D')
  ) stored,
  primary key (scope_kind, scope_key, id)
);
create index if not exists nodes_tsv on nodes using gin (tsv);
create index if not exists nodes_title_trgm on nodes using gin (lower(title) gin_trgm_ops);
create index if not exists nodes_scope_type on nodes (scope_kind, scope_key, type, status);
create index if not exists nodes_scope_path on nodes (scope_kind, scope_key, path);

create table if not exists edges (
  scope_kind text not null,
  scope_key text not null,
  id text not null,
  type text not null check (type in ('about', 'supersedes', 'depends_on', 'contradicts', 'part_of', 'derived_from', 'mentions')),
  from_id text not null,
  to_id text not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  recorded_at timestamptz not null default now(),
  confidence text not null default 'imported',
  source jsonb,
  primary key (scope_kind, scope_key, id),
  unique (scope_kind, scope_key, type, from_id, to_id),
  foreign key (scope_kind, scope_key, from_id) references nodes (scope_kind, scope_key, id) on delete cascade,
  foreign key (scope_kind, scope_key, to_id) references nodes (scope_kind, scope_key, id) on delete cascade
);
create index if not exists edges_from on edges (scope_kind, scope_key, from_id, type);
create index if not exists edges_to on edges (scope_kind, scope_key, to_id, type);

create table if not exists sources (
  scope_kind text not null,
  scope_key text not null,
  node_id text not null,
  ord integer not null,
  kind text not null,
  ref text not null,
  at text,
  hash text,
  range text,
  primary key (scope_kind, scope_key, node_id, ord),
  foreign key (scope_kind, scope_key, node_id) references nodes (scope_kind, scope_key, id) on delete cascade
);
create index if not exists sources_ref on sources (scope_kind, scope_key, kind, ref);

-- Normalised file paths and urls a node cites ('source') and the folders an entity covers ('entity'): layer-1 exact match.
create table if not exists match_keys (
  scope_kind text not null,
  scope_key text not null,
  kind text not null check (kind in ('source', 'entity')),
  key text not null,
  node_id text not null,
  primary key (scope_kind, scope_key, kind, key, node_id),
  foreign key (scope_kind, scope_key, node_id) references nodes (scope_kind, scope_key, id) on delete cascade
);

create table if not exists episodes (
  scope_kind text not null,
  scope_key text not null,
  id text not null,
  session_id text,
  agent_id text,
  started_at timestamptz,
  ended_at timestamptz,
  title text,
  steps_done integer,
  steps_total integer,
  files_written jsonb not null default '[]',
  urls_fetched jsonb not null default '[]',
  commands jsonb not null default '[]',
  commits jsonb not null default '[]',
  outcome text,
  primary key (scope_kind, scope_key, id)
);

-- Append-only change log. seq is the cursor of GET /v1/changes.
create table if not exists events (
  seq bigint generated always as identity primary key,
  scope_kind text not null,
  scope_key text not null,
  id text not null,
  at timestamptz not null,
  actor text not null,
  op text not null,
  target text not null,
  payload jsonb,
  idempotency_key text not null,
  schema_version integer not null default 1,
  unique (scope_kind, scope_key, id),
  unique (scope_kind, scope_key, idempotency_key)
);

create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only';
end $$;
drop trigger if exists events_no_update on events;
create trigger events_no_update before update or delete on events for each row execute function events_append_only();

-- Phase 7: who may see which scope.
create table if not exists memberships (
  principal text not null,
  scope_kind text not null,
  scope_key text not null,
  role text not null default 'member' check (role in ('member', 'admin')),
  primary key (principal, scope_kind, scope_key)
);

-- Only SHA-256 hashes of bearer tokens are stored.
create table if not exists tokens (
  token_hash text primary key,
  principal text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The one way an unprivileged role may check a token: it learns a principal, never reads the table.
create or replace function memory_verify_token(h text) returns text
  language sql stable security definer set search_path from current as
$$ select principal from tokens where token_hash = h and revoked_at is null $$;

-- Row-level security (08 §3). A row is visible only to a principal with a membership in its scope.
-- The server sets app.principal per transaction; with no principal set, nothing is visible.
-- FORCE applies the policies to the table owner too; superusers still bypass them.
do $$
declare t text;
begin
  foreach t in array array['nodes', 'edges', 'sources', 'match_keys', 'episodes', 'events', 'scopes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists scope_isolation on %I', t);
    execute format(
      $p$create policy scope_isolation on %I using (exists (select 1 from memberships m where m.principal = current_setting('app.principal', true) and m.scope_kind = %I.scope_kind and m.scope_key = %I.scope_key)) with check (exists (select 1 from memberships m where m.principal = current_setting('app.principal', true) and m.scope_kind = %I.scope_kind and m.scope_key = %I.scope_key))$p$,
      t, t, t, t, t);
  end loop;
end $$;

alter table memberships enable row level security;
alter table memberships force row level security;
drop policy if exists own_memberships on memberships;
create policy own_memberships on memberships for select using (principal = current_setting('app.principal', true));

-- tokens has no policy: an unprivileged role sees nothing and uses memory_verify_token.
alter table tokens enable row level security;
alter table tokens force row level security;
