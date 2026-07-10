-- Hosted v1 workspaces are personal. Deleting the owning Better Auth user must
-- remove the entire tenant graph rather than leave an inaccessible orphan.

ALTER TABLE workspace
  DROP CONSTRAINT IF EXISTS workspace_created_by_user_id_fkey;

UPDATE workspace tenant
SET created_by_user_id = (
  SELECT member.user_id
  FROM workspace_member member
  WHERE member.workspace_id = tenant.id
  ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    member.created_at
  LIMIT 1
)
WHERE tenant.created_by_user_id IS NULL;

-- A null owner with no member is an inaccessible remnant from a deleted test
-- or pre-launch account, so there is no user data path that could recover it.
DELETE FROM workspace WHERE created_by_user_id IS NULL;

ALTER TABLE workspace
  ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE workspace
  ADD CONSTRAINT workspace_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE CASCADE;
