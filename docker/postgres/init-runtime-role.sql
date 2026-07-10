-- Development-only Docker credential. Production operators should create a
-- distinct non-owner role and run `pnpm db:grant-runtime` after migrations.
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'draftrelay_app') THEN
    CREATE ROLE draftrelay_app
      LOGIN
      PASSWORD 'draftrelay_app'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$block$;

ALTER ROLE draftrelay_app SET row_security = on;
GRANT CONNECT ON DATABASE draftrelay TO draftrelay_app;
GRANT USAGE ON SCHEMA public TO draftrelay_app;
REVOKE CREATE ON SCHEMA public FROM draftrelay_app;

-- Migrations run as the draftrelay owner after this init hook. These defaults
-- make newly-created application tables usable by the runtime role without
-- making that role an owner (owners bypass forced RLS).
ALTER DEFAULT PRIVILEGES FOR ROLE draftrelay IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO draftrelay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE draftrelay IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO draftrelay_app;
