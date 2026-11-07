import type Database from 'better-sqlite3'

export const SCHEMA_VERSION = 11

// The base (v1) schema. Applied unconditionally on every open (see db.ts) --
// every statement here has been additive-safe (CREATE ... IF NOT EXISTS)
// since v1, which is why it's always been run regardless of the stored
// schema_version. New tables introduced by later schema versions do NOT
// belong here: they go in MIGRATIONS below, gated on the stored version, so
// the migration path is actually exercised (and testable) rather than
// silently short-circuited by this unconditional exec.
export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  dir_name      TEXT NOT NULL UNIQUE,
  cwd           TEXT,
  last_activity TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('main','subagent')),
  agent_id        TEXT,
  tool_use_id     TEXT,
  agent_type      TEXT,
  agent_desc      TEXT,
  file_path       TEXT NOT NULL UNIQUE,
  file_size       INTEGER NOT NULL DEFAULT 0,
  file_mtime_ms   INTEGER NOT NULL DEFAULT 0,
  indexed_offset  INTEGER NOT NULL DEFAULT 0,
  indexed_seq     INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  first_ts        TEXT,
  last_ts         TEXT,
  title           TEXT,
  model           TEXT,
  git_branch      TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_id, last_ts DESC);
CREATE INDEX IF NOT EXISTS sessions_by_tool_use ON sessions(tool_use_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  session_pk   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  uuid         TEXT NOT NULL,
  parent_uuid  TEXT,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  ts           TEXT,
  model        TEXT,
  byte_offset  INTEGER NOT NULL,
  text         TEXT,
  tool_names   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_uuid ON messages(session_pk, uuid);
CREATE INDEX IF NOT EXISTS messages_seq ON messages(session_pk, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`

export type Migration = { toVersion: number; apply: (db: Database.Database) => void }

// v2: app-owned channel metadata (rename/favorite/group/icon), keyed by the
// project's stable dir_name so it survives a catalog rebuild (the catalog is
// derived from ~/.claude on demand; this data is not -- see Plan 3 Global
// Constraints). channel_groups must be created before channel_meta since the
// latter's group_id references it.
const MIGRATION_2_CHANNEL_METADATA = `
CREATE TABLE IF NOT EXISTS channel_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_meta (
  dir_name      TEXT PRIMARY KEY,
  friendly_name TEXT,
  starred       INTEGER NOT NULL DEFAULT 0,
  group_id      INTEGER REFERENCES channel_groups(id) ON DELETE SET NULL,
  icon_json     TEXT
);
`

// Ordered by toVersion ascending. db.ts runs every step whose toVersion is
// greater than the DB's stored schema_version, in array order, then stamps
// schema_version to SCHEMA_VERSION -- so a DB opened at any past version
// (including a fresh v0/null one) catches up through every intervening step
// without dropping or altering the tables/rows a prior version wrote.
const MIGRATION_3_SETTINGS = `
CREATE TABLE IF NOT EXISTS settings_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// v4: a per-channel "hidden" flag so a channel can be removed from the nav
// without deleting its transcripts (reversible — hidden channels drop into a
// collapsed "Hidden" section). Added by ALTER (not the base DDL) so an existing
// v2/v3 catalog gains the column in place rather than being rebuilt. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so this is applied conditionally on the column
// being absent — keeping the step idempotent like the CREATE IF NOT EXISTS
// migrations above, so re-running the runner from a lowered version can't throw
// "duplicate column name".
/** Token totals counted repeated rows many times over, so every chat is re-read: an
 *  offset past the end of a file reads as rewritten, which rebuilds the totals. */
function countUsagePerMessage(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'last_usage')) db.exec('ALTER TABLE sessions ADD COLUMN last_usage TEXT')
  db.exec('UPDATE sessions SET indexed_offset = 9007199254740991')
}

/** A chat's name as Claude Code records it. Re-reading every chat picks up the existing ones. */
function addChatNames(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'custom_title')) db.exec('ALTER TABLE sessions ADD COLUMN custom_title TEXT')
  if (!cols.some(c => c.name === 'ai_title')) db.exec('ALTER TABLE sessions ADD COLUMN ai_title TEXT')
  db.exec('UPDATE sessions SET indexed_offset = 9007199254740991')
}

function addHiddenColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(channel_meta)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'hidden')) {
    db.exec('ALTER TABLE channel_meta ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  }
}

// v5: a per-group custom icon (emoji/color/image), stored as JSON like a
// channel's icon_json. Added by conditional ALTER for the same idempotency
// reasons as addHiddenColumn.
function addGroupIconColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(channel_groups)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'icon_json')) {
    db.exec('ALTER TABLE channel_groups ADD COLUMN icon_json TEXT')
  }
}

// v6: what each project remembers (model, effort, permissions, ...), shared by its chats.
const MIGRATION_6_PROJECT_SETTINGS = `
CREATE TABLE IF NOT EXISTS project_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  json       TEXT NOT NULL
);
`

const MIGRATION_11_PINS = `
  CREATE TABLE IF NOT EXISTS pinned_messages (
    session_pk INTEGER NOT NULL,
    uuid TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (session_pk, uuid)
  );
`

/** Marks rows a rewind went past, which stay in the transcript but aren't part of the chat. */
function addRewoundColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'rewound')) db.exec('ALTER TABLE messages ADD COLUMN rewound INTEGER NOT NULL DEFAULT 0')
}

export const MIGRATIONS: Migration[] = [
  { toVersion: 2, apply: db => db.exec(MIGRATION_2_CHANNEL_METADATA) },
  { toVersion: 3, apply: db => db.exec(MIGRATION_3_SETTINGS) },
  { toVersion: 4, apply: addHiddenColumn },
  { toVersion: 5, apply: addGroupIconColumn },
  { toVersion: 6, apply: db => db.exec(MIGRATION_6_PROJECT_SETTINGS) },
  // Messages sent mid-turn weren't indexed. An offset past the end of a file reads as
  // rewritten, so the next index pass rebuilds each chat cleanly, picking them up.
  { toVersion: 7, apply: db => db.exec('UPDATE sessions SET indexed_offset = 9007199254740991') },
  { toVersion: 8, apply: countUsagePerMessage },
  { toVersion: 9, apply: addChatNames },
  { toVersion: 10, apply: addRewoundColumn },
  { toVersion: 11, apply: db => db.exec(MIGRATION_11_PINS) }
]
