-- 0048_project_review_status: The GitHub login whose gh token posts review stamps for a project (hub project review-status).
-- A missing row means use gh's active account. The row holds a login only, never a token; the daemon asks gh for the token per post.
-- A side table instead of ADD COLUMN keeps this migration re-runnable.
CREATE TABLE IF NOT EXISTS project_review_status (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  account    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
