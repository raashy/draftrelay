-- Enforce the advertised connected-client limits at the durable consent layer.
-- Dynamic registration remains IP-rate-limited and unauthenticated for MCP
-- compatibility; abandoned registrations are removed by application
-- maintenance, while a user cannot consent to more than their plan permits.

CREATE FUNCTION draftrelay_private.enforce_oauth_consent_quota()
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

CREATE TRIGGER oauth_consent_quota
  BEFORE INSERT OR UPDATE OF "clientId", "userId" ON "oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.enforce_oauth_consent_quota();
