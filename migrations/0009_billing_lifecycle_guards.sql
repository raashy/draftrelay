-- Serialize checkout/account-deletion intent and prevent user-scoped billing
-- rows from surviving or being inserted after their user is gone.

CREATE TABLE account_deletion_guard (
  user_id uuid PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE subscription
  ADD COLUMN reference_user_id uuid
    GENERATED ALWAYS AS ("referenceId"::uuid) STORED NOT NULL
    REFERENCES "user" (id) ON DELETE CASCADE;

CREATE INDEX subscription_reference_user_id_idx
  ON subscription (reference_user_id);

CREATE FUNCTION draftrelay_private.enforce_subscription_user_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reference_user_id uuid;
BEGIN
  IF NEW."referenceId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'subscription_user_reference_invalid'
      USING ERRCODE = '23503';
  END IF;
  reference_user_id := NEW."referenceId"::uuid;
  IF EXISTS (SELECT 1 FROM public.account_deletion_guard WHERE user_id = reference_user_id) THEN
    RAISE EXCEPTION 'account_deletion_in_progress'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION draftrelay_private.enforce_subscription_user_reference() FROM PUBLIC;

CREATE TRIGGER subscription_user_reference_guard
  BEFORE INSERT OR UPDATE OF "referenceId" ON subscription
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.enforce_subscription_user_reference();

ALTER TABLE subscription
  ADD COLUMN "stripeSyncedAt" timestamptz,
  ADD COLUMN "stripeEventCreated" bigint;

CREATE FUNCTION public.draftrelay_has_paid_entitlement(
  principal_user_id uuid,
  target_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM subscription
    WHERE "referenceId" = principal_user_id::text
      AND plan = 'pro'
      AND status IN ('active', 'trialing')
      AND "stripeSyncedAt" > CURRENT_TIMESTAMP - INTERVAL '24 hours'
  ) OR (
    target_workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM workspace
      WHERE id = target_workspace_id
        AND plan IN ('pro', 'enterprise')
    )
  );
$$;

COMMENT ON FUNCTION public.draftrelay_has_paid_entitlement(uuid, uuid) IS
  'Authoritative paid-tier predicate: fresh active/trialing Stripe Pro or a Pro/Enterprise workspace override.';

CREATE OR REPLACE FUNCTION draftrelay_private.enforce_oauth_consent_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  connected_count integer;
  connection_limit integer;
  entitlement_workspace_id uuid;
  previous_user_id text;
  previous_workspace_id text;
BEGIN
  IF NEW."userId" IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('draftrelay:oauth-consent:' || NEW."userId"::text, 0)
  );

  previous_user_id := current_setting('app.user_id', true);
  previous_workspace_id := current_setting('app.workspace_id', true);
  PERFORM set_config('app.user_id', NEW."userId"::text, true);

  SELECT member.workspace_id
  INTO entitlement_workspace_id
  FROM workspace_member member
  WHERE member.user_id = NEW."userId"
  ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    member.created_at,
    member.workspace_id
  LIMIT 1;

  PERFORM set_config(
    'app.workspace_id',
    COALESCE(entitlement_workspace_id::text, ''),
    true
  );

  SELECT CASE WHEN public.draftrelay_has_paid_entitlement(
    NEW."userId",
    entitlement_workspace_id
  ) THEN 20 ELSE 3 END
  INTO connection_limit;

  PERFORM set_config('app.user_id', COALESCE(previous_user_id, ''), true);
  PERFORM set_config('app.workspace_id', COALESCE(previous_workspace_id, ''), true);

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

CREATE INDEX subscription_stripe_sync_idx
  ON subscription ("stripeSyncedAt", status)
  WHERE "stripeSubscriptionId" IS NOT NULL;

ALTER TABLE webhook_event
  DROP CONSTRAINT webhook_event_status_check,
  ADD CONSTRAINT webhook_event_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'ignored', 'dead_letter'));

CREATE INDEX webhook_event_dead_letter_idx
  ON webhook_event (received_at)
  WHERE status = 'dead_letter';

COMMENT ON TABLE account_deletion_guard IS
  'Durable marker that prevents checkout and subscription inserts while account deletion is in progress.';
COMMENT ON COLUMN subscription."stripeSyncedAt" IS
  'Last time the local billing state was reconciled against an authoritative Stripe subscription response.';
