export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

CREATE TABLE backup_sources (
  source_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  batch_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES backup_sources(source_id),
  scope_key TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('live','historical')),
  capture_seq INTEGER CHECK (capture_seq > 0),
  captured_at TEXT,
  captured_at_kind TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_format TEXT NOT NULL,
  converter_version TEXT NOT NULL,
  raw_manifest TEXT,
  raw_sha256 TEXT,
  read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  detail_json TEXT,
  UNIQUE (source_id, scope_key, batch_id, status, capture_mode),
  UNIQUE (source_id, batch_id),
  UNIQUE (source_id, capture_seq),
  CHECK (capture_mode = 'live' OR capture_seq IS NULL),
  CHECK (status NOT IN ('complete','partial') OR
    (captured_at IS NOT NULL AND finished_at IS NOT NULL
      AND raw_manifest IS NOT NULL AND raw_sha256 IS NOT NULL
      AND (capture_mode = 'historical' OR capture_seq IS NOT NULL)))
);

CREATE TABLE source_records (
  record_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES backup_sources(source_id),
  native_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, native_id),
  UNIQUE (source_id, record_id)
);

CREATE TABLE record_versions (
  version_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES source_records(record_id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (record_id, content_hash),
  UNIQUE (record_id, version_id)
);

CREATE TABLE batch_records (
  batch_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version_id TEXT,
  project_id TEXT,
  search_allowed INTEGER NOT NULL CHECK (search_allowed IN (0,1)),
  visibility TEXT NOT NULL CHECK (visibility IN ('visible','unavailable','deleted')),
  visibility_reason TEXT,
  source_updated_at TEXT,
  raw_ref TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, record_id),
  FOREIGN KEY (source_id, batch_id) REFERENCES import_batches(source_id, batch_id),
  FOREIGN KEY (source_id, record_id) REFERENCES source_records(source_id, record_id),
  FOREIGN KEY (record_id, version_id) REFERENCES record_versions(record_id, version_id),
  CHECK (visibility <> 'visible' OR version_id IS NOT NULL)
);

CREATE TABLE backup_scope_heads (
  source_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status = 'complete'),
  capture_mode TEXT NOT NULL DEFAULT 'live' CHECK (capture_mode = 'live'),
  PRIMARY KEY (source_id, scope_key),
  FOREIGN KEY (source_id, scope_key, batch_id, status, capture_mode)
    REFERENCES import_batches(source_id, scope_key, batch_id, status, capture_mode)
);

CREATE TABLE backup_operations (
  scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE REFERENCES import_batches(batch_id),
  receipt_json TEXT,
  PRIMARY KEY (scope_id, operation_id)
);

CREATE TABLE heat (
  record_id TEXT PRIMARY KEY REFERENCES source_records(record_id),
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  explicit_feedback INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE record_fts USING fts5(
  title, body, version_id UNINDEXED, tokenize='trigram'
);

CREATE INDEX idx_batches_scope ON import_batches(source_id, scope_key, capture_seq, batch_id);
CREATE UNIQUE INDEX idx_running_live_source ON import_batches(source_id)
  WHERE status = 'running' AND capture_mode = 'live';
CREATE INDEX idx_batch_records_lookup ON batch_records(record_id, batch_id);
CREATE INDEX idx_batch_records_filter ON batch_records(batch_id, project_id, visibility, search_allowed);
`;
