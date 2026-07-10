-- Let the application resolve a verified user's workspace before it has a
-- workspace context. The application sets app.user_id from an authenticated
-- browser session or a verified OAuth access-token subject. Writes remain
-- protected by the workspace policy from 0002.

CREATE POLICY workspace_member_self_lookup_policy ON workspace_member
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

COMMENT ON POLICY workspace_member_self_lookup_policy ON workspace_member IS
  'Allows lookup only for the verified app.user_id while resolving tenant context.';
