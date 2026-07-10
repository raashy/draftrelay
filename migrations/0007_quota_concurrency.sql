-- Serialize per-user OAuth consent checks so concurrent approvals cannot race
-- past the connected-client ceiling. Also place a durable, concurrency-safe
-- upper bound on tenant-controlled secret patterns.

CREATE OR REPLACE FUNCTION draftrelay_private.enforce_oauth_consent_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  connected_count integer;
  connection_limit integer;
BEGIN
  IF NEW."userId" IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('draftrelay:oauth-consent:' || NEW."userId"::text, 0)
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM subscription
    WHERE "referenceId" = NEW."userId"::text
      AND plan = 'pro'
      AND status IN ('active', 'trialing')
  ) THEN 20 ELSE 3 END
  INTO connection_limit;

  SELECT count(DISTINCT "clientId")
  INTO connected_count
  FROM "oauthConsent"
  WHERE "userId" = NEW."userId"
    AND "clientId" <> NEW."clientId";

  IF connected_count >= connection_limit THEN
    RAISE EXCEPTION 'oauth_client_quota_exceeded'
      USING ERRCODE = 'P0001',
            DETAIL = format('Connected MCP client limit is %s', connection_limit);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION draftrelay_private.enforce_oauth_consent_quota() FROM PUBLIC;

CREATE FUNCTION draftrelay_private.enforce_secret_pattern_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  pattern_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'draftrelay:secret-pattern:' || NEW.workspace_id::text || ':' || NEW.project_id::text,
      0
    )
  );

  IF TG_OP = 'UPDATE' THEN
    SELECT count(*)
    INTO pattern_count
    FROM project_secret_pattern
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND NOT (workspace_id = OLD.workspace_id AND id = OLD.id);
  ELSE
    SELECT count(*)
    INTO pattern_count
    FROM project_secret_pattern
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id;
  END IF;

  IF pattern_count >= 50 THEN
    RAISE EXCEPTION 'secret_pattern_quota_exceeded'
      USING ERRCODE = 'P0001',
            DETAIL = 'A project can have at most 50 custom secret patterns';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION draftrelay_private.enforce_secret_pattern_quota() FROM PUBLIC;

CREATE TRIGGER project_secret_pattern_quota
  BEFORE INSERT OR UPDATE OF workspace_id, project_id ON project_secret_pattern
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.enforce_secret_pattern_quota();
