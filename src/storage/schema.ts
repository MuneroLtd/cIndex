/**
 * SQLite schema for the cindex codebase graph.
 *
 * All tables use INTEGER PRIMARY KEY AUTOINCREMENT for stable row IDs.
 * Foreign keys cascade deletes so removing a repo cleans up everything.
 * FTS5 provides full-text search over symbol names and file paths.
 */
export const SCHEMA_SQL = `
-- Enable WAL mode and foreign keys (also set in Database constructor)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Core tables
-- ============================================================

CREATE TABLE IF NOT EXISTS repos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path  TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path            TEXT    NOT NULL,
  lang            TEXT    NOT NULL,
  sha256          TEXT    NOT NULL,
  mtime           REAL    NOT NULL,
  size_bytes      INTEGER NOT NULL,
  last_indexed_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  fq_name    TEXT    NOT NULL,
  signature  TEXT,
  start_line INTEGER NOT NULL,
  start_col  INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  end_col    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  version       TEXT,
  manifest_path TEXT    NOT NULL,
  UNIQUE(repo_id, name)
);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  src_type   TEXT    NOT NULL,
  src_id     INTEGER NOT NULL,
  rel        TEXT    NOT NULL,
  dst_type   TEXT    NOT NULL,
  dst_id     INTEGER NOT NULL,
  meta_json  TEXT,
  weight     REAL    NOT NULL DEFAULT 1.0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Full-text search (FTS5)
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  repo_id   UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  text
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_files_repo_path
  ON files(repo_id, path);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_file
  ON symbols(repo_id, file_id);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_name
  ON symbols(repo_id, name);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_fqname
  ON symbols(repo_id, fq_name);

CREATE INDEX IF NOT EXISTS idx_edges_repo_src
  ON edges(repo_id, src_type, src_id);

CREATE INDEX IF NOT EXISTS idx_edges_repo_dst
  ON edges(repo_id, dst_type, dst_id);

CREATE INDEX IF NOT EXISTS idx_edges_repo_rel
  ON edges(repo_id, rel);
`;
