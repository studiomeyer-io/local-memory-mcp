-- 002_vector.sql — sqlite-vec embeddings table for hybrid search.
--
-- Applied only when sqlite-vec successfully loaded. Idempotent: every
-- statement is IF NOT EXISTS / INSERT OR REPLACE so this can be re-run on
-- every boot without side effects.
--
-- Schema design:
--   * `embeddings` is a vec0 virtual table. `content_id` is a TEXT primary key
--     so it can join cleanly against `learnings.id`, `decisions.id`, and
--     `entity_observations.id` (all TEXT UUIDs).
--   * `+content_type` is an auxiliary column. `+` marks it as metadata stored
--     alongside the vector — it is filterable in WHERE clauses but not part of
--     the vector index, so we can disambiguate between content types without
--     paying for a wider index.
--   * The vector itself is 384-dim float (Xenova/multilingual-e5-small).
--
-- Hybrid search reads from this table via:
--   SELECT content_id, content_type, distance
--   FROM embeddings
--   WHERE embedding MATCH ?
--     AND k = 50
--   ORDER BY distance;

CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
  content_id TEXT PRIMARY KEY,
  +content_type TEXT,
  embedding float[384]
);

-- Schema-version bump + embedding model fingerprint. INSERT OR REPLACE so
-- re-running this on a v2 DB just refreshes the value, no-op on the data.
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dim', '384');
INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', 'Xenova/multilingual-e5-small');
