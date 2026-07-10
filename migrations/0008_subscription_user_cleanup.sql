-- Keep Better Auth user deletion and local billing-row cleanup atomic.
-- subscription.referenceId is text because the upstream plugin supports more
-- than one reference type; this deployment authorizes user UUID references only.

CREATE FUNCTION draftrelay_private.delete_user_subscriptions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.subscription
  WHERE "referenceId" = OLD.id::text;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION draftrelay_private.delete_user_subscriptions() FROM PUBLIC;

CREATE TRIGGER user_subscription_cleanup
  BEFORE DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.delete_user_subscriptions();

COMMENT ON FUNCTION draftrelay_private.delete_user_subscriptions() IS
  'Deletes user-scoped Better Auth subscription rows in the same statement transaction as account deletion.';
