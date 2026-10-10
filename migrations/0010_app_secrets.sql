-- Server-side secrets the Worker generates for itself (for example the key that signs cast media URLs).
CREATE TABLE IF NOT EXISTS app_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
