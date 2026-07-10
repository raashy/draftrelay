-- Hosted, tenant-isolated DraftRelay domain schema.
-- Authentication tables intentionally remain outside RLS because Better Auth
-- accesses them before an application workspace context exists. All domain data
-- below is protected with forced row-level security.

CREATE SCHEMA draftrelay_private;
REVOKE ALL ON SCHEMA draftrelay_private FROM PUBLIC;

CREATE FUNCTION draftrelay_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION draftrelay_private.touch_updated_at() FROM PUBLIC;

CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
  created_by_user_id uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_member (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_member_user_id_idx ON workspace_member (user_id, workspace_id);

CREATE TABLE project (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  normalized_name text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  default_recipe_id text NOT NULL DEFAULT 'generic_note'
    CHECK (default_recipe_id IN (
      'slack_update', 'client_email', 'github_pr', 'incident_summary', 'decision',
      'command_set', 'generic_reply', 'generic_summary', 'generic_action',
      'generic_snippet', 'generic_note'
    )),
  default_destination text NOT NULL DEFAULT 'markdown'
    CHECK (default_destination IN ('plain', 'markdown', 'slack', 'email', 'github')),
  default_destination_explicit boolean NOT NULL DEFAULT false,
  allowed_destinations text[] NOT NULL DEFAULT ARRAY['plain', 'markdown', 'slack', 'email', 'github']::text[]
    CHECK (
      cardinality(allowed_destinations) BETWEEN 1 AND 5
      AND allowed_destinations <@ ARRAY['plain', 'markdown', 'slack', 'email', 'github']::text[]
    ),
  secret_mode text NOT NULL DEFAULT 'block_high'
    CHECK (secret_mode IN ('off', 'warn', 'block_high', 'block_all')),
  require_secret_ack boolean NOT NULL DEFAULT true,
  require_review_before_copy boolean NOT NULL DEFAULT false,
  copy_behavior text NOT NULL DEFAULT 'mark_copied'
    CHECK (copy_behavior IN ('no_change', 'mark_copied', 'mark_done')),
  retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT project_workspace_name_unique UNIQUE (workspace_id, normalized_name),
  CONSTRAINT project_default_destination_allowed CHECK (default_destination = ANY (allowed_destinations))
);

CREATE INDEX project_id_lookup_idx ON project (id);

CREATE TABLE project_secret_pattern (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  project_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  pattern_kind text NOT NULL CHECK (pattern_kind IN ('literal', 'glob')),
  pattern text NOT NULL CHECK (char_length(pattern) BETWEEN 3 AND 240),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES project (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX project_secret_pattern_project_idx
  ON project_secret_pattern (workspace_id, project_id, created_at);

CREATE TABLE output_item (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  content_markdown text NOT NULL CHECK (char_length(content_markdown) BETWEEN 1 AND 12000),
  content_bytes integer GENERATED ALWAYS AS (octet_length(content_markdown)) STORED,
  kind text NOT NULL CHECK (kind IN ('summary', 'reply', 'action', 'snippet', 'note')),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (cardinality(tags) <= 8),
  source_client text NOT NULL DEFAULT 'manual' CHECK (char_length(source_client) BETWEEN 1 AND 64),
  recipe_id text NOT NULL DEFAULT 'generic_note'
    CHECK (recipe_id IN (
      'slack_update', 'client_email', 'github_pr', 'incident_summary', 'decision',
      'command_set', 'generic_reply', 'generic_summary', 'generic_action',
      'generic_snippet', 'generic_note'
    )),
  recipe_payload jsonb CHECK (recipe_payload IS NULL OR jsonb_typeof(recipe_payload) = 'object'),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'copied', 'done')),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  status_before_done text CHECK (status_before_done IS NULL OR status_before_done IN ('new', 'reviewed', 'copied')),
  reviewed_at timestamptz,
  copied_at timestamptz,
  done_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES project (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT output_item_done_dates CHECK (
    (status = 'done' AND done_at IS NOT NULL)
    OR (status <> 'done' AND done_at IS NULL AND expires_at IS NULL)
  )
);

CREATE INDEX output_item_id_lookup_idx ON output_item (id);
CREATE INDEX output_item_outbox_idx
  ON output_item (workspace_id, status, updated_at DESC, id DESC);
CREATE INDEX output_item_project_idx
  ON output_item (workspace_id, project_id, updated_at DESC);
CREATE INDEX output_item_recipe_idx ON output_item (workspace_id, recipe_id);
CREATE INDEX output_item_tags_idx ON output_item USING gin (tags);
CREATE INDEX output_item_expiry_idx
  ON output_item (expires_at)
  WHERE status = 'done' AND expires_at IS NOT NULL;
CREATE INDEX output_item_search_idx
  ON output_item USING gin (to_tsvector('simple', title || ' ' || content_markdown));

CREATE TABLE output_revision (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  item_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  content_markdown text NOT NULL CHECK (char_length(content_markdown) BETWEEN 1 AND 12000),
  content_bytes integer GENERATED ALWAYS AS (octet_length(content_markdown)) STORED,
  recipe_id text NOT NULL
    CHECK (recipe_id IN (
      'slack_update', 'client_email', 'github_pr', 'incident_summary', 'decision',
      'command_set', 'generic_reply', 'generic_summary', 'generic_action',
      'generic_snippet', 'generic_note'
    )),
  recipe_payload jsonb CHECK (recipe_payload IS NULL OR jsonb_typeof(recipe_payload) = 'object'),
  change_note text CHECK (change_note IS NULL OR char_length(change_note) <= 500),
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'human', 'migration', 'system')),
  author_user_id uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  author_label text NOT NULL CHECK (char_length(author_label) BETWEEN 1 AND 100),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 240),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, item_id)
    REFERENCES output_item (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT output_revision_sequence_unique UNIQUE (workspace_id, item_id, revision)
);

CREATE UNIQUE INDEX output_revision_idempotency_idx
  ON output_revision (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX output_revision_item_idx
  ON output_revision (workspace_id, item_id, revision DESC);

ALTER TABLE output_item
  ADD CONSTRAINT output_item_current_revision_fk
  FOREIGN KEY (workspace_id, id, current_revision)
  REFERENCES output_revision (workspace_id, item_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE output_provenance (
  workspace_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_client text NOT NULL CHECK (char_length(source_client) BETWEEN 1 AND 64),
  source_client_version text,
  agent_name text,
  model text,
  session_id text,
  cwd text,
  repo_root text,
  repo_remote text,
  branch text,
  commit_sha text,
  repo_dirty boolean,
  capture_method text NOT NULL
    CHECK (capture_method IN ('client_supplied', 'server_detected', 'legacy', 'manual')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'passed', 'partial', 'failed')),
  verification_summary text,
  captured_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, revision_id),
  FOREIGN KEY (workspace_id, revision_id)
    REFERENCES output_revision (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE referenced_file (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  revision_id uuid NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2000),
  line_start integer CHECK (line_start IS NULL OR line_start > 0),
  line_end integer CHECK (line_end IS NULL OR line_end > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, revision_id)
    REFERENCES output_revision (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT referenced_file_line_order CHECK (
    line_start IS NULL OR line_end IS NULL OR line_end >= line_start
  )
);

CREATE INDEX referenced_file_revision_idx
  ON referenced_file (workspace_id, revision_id, path);

CREATE TABLE secret_finding (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  revision_id uuid NOT NULL,
  scanner_version integer NOT NULL CHECK (scanner_version > 0),
  rule_id text NOT NULL,
  label text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  action text NOT NULL CHECK (action IN ('warn', 'block')),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  line_number integer NOT NULL CHECK (line_number > 0),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) = 64),
  redacted_preview text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'false_positive')),
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, revision_id)
    REFERENCES output_revision (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT secret_finding_location_unique
    UNIQUE (workspace_id, revision_id, rule_id, start_offset, end_offset),
  CONSTRAINT secret_finding_ack_state CHECK (
    (status = 'open' AND acknowledged_at IS NULL)
    OR (status <> 'open' AND acknowledged_at IS NOT NULL)
  )
);

CREATE INDEX secret_finding_revision_idx
  ON secret_finding (workspace_id, revision_id, status, line_number);

CREATE TABLE output_representation (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  item_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  destination text NOT NULL CHECK (destination IN ('plain', 'markdown', 'slack', 'email', 'github')),
  transformer_version integer NOT NULL CHECK (transformer_version > 0),
  plain_text text NOT NULL,
  markdown_text text,
  html_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  checksum text NOT NULL CHECK (char_length(checksum) = 64),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, item_id, revision)
    REFERENCES output_revision (workspace_id, item_id, revision) ON DELETE CASCADE,
  CONSTRAINT output_representation_version_unique
    UNIQUE (workspace_id, item_id, revision, destination, transformer_version)
);

CREATE INDEX output_representation_item_idx
  ON output_representation (workspace_id, item_id, revision DESC);

CREATE TABLE output_event (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  item_id uuid NOT NULL,
  revision integer,
  event_type text NOT NULL,
  destination text CHECK (destination IS NULL OR destination IN ('plain', 'markdown', 'slack', 'email', 'github')),
  representation_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('agent', 'human', 'system', 'migration')),
  actor_user_id uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  oauth_client_id text REFERENCES "oauthClient" ("clientId") ON DELETE SET NULL,
  actor_label text NOT NULL CHECK (char_length(actor_label) BETWEEN 1 AND 100),
  client_event_id text CHECK (client_event_id IS NULL OR char_length(client_event_id) <= 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, item_id)
    REFERENCES output_item (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, item_id, revision)
    REFERENCES output_revision (workspace_id, item_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, representation_id)
    REFERENCES output_representation (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX output_event_client_idempotency_idx
  ON output_event (workspace_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
CREATE INDEX output_event_item_idx
  ON output_event (workspace_id, item_id, created_at DESC);

CREATE TABLE workspace_entitlement (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  feature_key text NOT NULL CHECK (char_length(feature_key) BETWEEN 1 AND 100),
  value jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('free', 'stripe', 'admin')),
  valid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, feature_key)
);

CREATE TABLE usage_counter (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (char_length(metric) BETWEEN 1 AND 100),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, metric, period_start),
  CONSTRAINT usage_counter_period_order CHECK (period_end > period_start)
);

CREATE INDEX usage_counter_current_idx
  ON usage_counter (workspace_id, metric, period_end DESC);

CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  oauth_client_id text REFERENCES "oauthClient" ("clientId") ON DELETE SET NULL,
  request_id text,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 80),
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
  ip_address inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_event_workspace_time_idx
  ON audit_event (workspace_id, created_at DESC, id DESC);
CREATE INDEX audit_event_actor_idx
  ON audit_event (workspace_id, actor_user_id, created_at DESC);
CREATE INDEX audit_event_action_idx
  ON audit_event (workspace_id, action, created_at DESC);

-- Service-only webhook inbox. It is not tenant-RLS protected because a webhook
-- can arrive before its provider customer/reference has been resolved.
CREATE TABLE webhook_event (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('stripe')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  workspace_id uuid REFERENCES workspace (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'ignored')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT webhook_event_provider_unique UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_event_pending_idx
  ON webhook_event (status, next_attempt_at, received_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_event_workspace_idx
  ON webhook_event (workspace_id, received_at DESC);

CREATE TRIGGER workspace_touch_updated_at
  BEFORE UPDATE ON workspace
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER workspace_member_touch_updated_at
  BEFORE UPDATE ON workspace_member
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER project_touch_updated_at
  BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER output_item_touch_updated_at
  BEFORE UPDATE ON output_item
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER workspace_entitlement_touch_updated_at
  BEFORE UPDATE ON workspace_entitlement
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER usage_counter_touch_updated_at
  BEFORE UPDATE ON usage_counter
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();
CREATE TRIGGER webhook_event_touch_updated_at
  BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION draftrelay_private.touch_updated_at();

ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_tenant_policy ON workspace
  USING (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_member',
    'project',
    'project_secret_pattern',
    'output_item',
    'output_revision',
    'output_provenance',
    'referenced_file',
    'secret_finding',
    'output_representation',
    'output_event',
    'workspace_entitlement',
    'usage_counter',
    'audit_event'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      table_name || '_tenant_policy',
      table_name
    );
  END LOOP;
END;
$$;

COMMENT ON SCHEMA draftrelay_private IS
  'Internal trigger functions; application roles should not receive direct privileges.';
COMMENT ON TABLE webhook_event IS
  'Service-only idempotent webhook inbox. Payloads must never be exposed through tenant APIs.';
COMMENT ON TABLE audit_event IS
  'Content-free security audit trail; do not store output bodies, credentials, or raw tokens in metadata.';
COMMENT ON COLUMN "oauthClient"."referenceId" IS
  'Workspace UUID serialized as text for workspace-bound MCP grants.';
COMMENT ON COLUMN "oauthConsent"."referenceId" IS
  'Workspace UUID serialized as text for workspace-bound consent.';
COMMENT ON COLUMN "oauthAccessToken"."referenceId" IS
  'Workspace UUID serialized as text for workspace-bound access tokens.';
COMMENT ON COLUMN "oauthRefreshToken"."referenceId" IS
  'Workspace UUID serialized as text for workspace-bound refresh tokens.';
