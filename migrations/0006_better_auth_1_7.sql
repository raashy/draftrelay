-- Better Auth 1.7 OAuth/JWT schema additions.
--
-- oauthClientResource and oauthClientAssertion deliberately use text primary
-- keys. The provider supplies deterministic, non-UUID IDs for idempotent
-- client/resource links and private_key_jwt replay prevention.

ALTER TABLE "jwks"
  ADD COLUMN "alg" text,
  ADD COLUMN "crv" text;

ALTER TABLE "oauthClient"
  ADD COLUMN "backchannelLogoutUri" text,
  ADD COLUMN "backchannelLogoutSessionRequired" boolean,
  ADD COLUMN "jwks" text,
  ADD COLUMN "jwksUri" text,
  ADD COLUMN "dpopBoundAccessTokens" boolean DEFAULT false;

CREATE TABLE "oauthResource" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb
    CHECK ("allowedScopes" IS NULL OR jsonb_typeof("allowedScopes") = 'array'),
  "customClaims" jsonb
    CHECK ("customClaims" IS NULL OR jsonb_typeof("customClaims") = 'object'),
  "dpopBoundAccessTokensRequired" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer DEFAULT 1,
  "metadata" jsonb
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);

CREATE TABLE "oauthClientResource" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" jsonb
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object'),
  "createdAt" timestamptz,
  CONSTRAINT oauth_client_resource_pair_unique UNIQUE ("clientId", "resourceId")
);

CREATE INDEX oauth_client_resource_client_id_idx
  ON "oauthClientResource" ("clientId");
CREATE INDEX oauth_client_resource_resource_id_idx
  ON "oauthClientResource" ("resourceId");

ALTER TABLE "oauthRefreshToken"
  ADD COLUMN "authorizationCodeId" text,
  ADD COLUMN "resources" jsonb
    CHECK ("resources" IS NULL OR jsonb_typeof("resources") = 'array'),
  ADD COLUMN "requestedUserInfoClaims" jsonb
    CHECK (
      "requestedUserInfoClaims" IS NULL
      OR jsonb_typeof("requestedUserInfoClaims") = 'array'
    ),
  ADD COLUMN "rotatedAt" timestamptz,
  ADD COLUMN "rotationReplayResponse" text,
  ADD COLUMN "rotationReplayExpiresAt" timestamptz,
  ADD COLUMN "confirmation" jsonb
    CHECK ("confirmation" IS NULL OR jsonb_typeof("confirmation") = 'object');

CREATE INDEX oauth_refresh_token_authorization_code_id_idx
  ON "oauthRefreshToken" ("authorizationCodeId");

ALTER TABLE "oauthAccessToken"
  ADD COLUMN "authorizationCodeId" text,
  ADD COLUMN "resources" jsonb
    CHECK ("resources" IS NULL OR jsonb_typeof("resources") = 'array'),
  ADD COLUMN "requestedUserInfoClaims" jsonb
    CHECK (
      "requestedUserInfoClaims" IS NULL
      OR jsonb_typeof("requestedUserInfoClaims") = 'array'
    ),
  ADD COLUMN "revoked" timestamptz,
  ADD COLUMN "confirmation" jsonb
    CHECK ("confirmation" IS NULL OR jsonb_typeof("confirmation") = 'object');

CREATE INDEX oauth_access_token_authorization_code_id_idx
  ON "oauthAccessToken" ("authorizationCodeId");

ALTER TABLE "oauthConsent"
  ADD COLUMN "resources" jsonb
    CHECK ("resources" IS NULL OR jsonb_typeof("resources") = 'array'),
  ADD COLUMN "requestedUserInfoClaims" jsonb
    CHECK (
      "requestedUserInfoClaims" IS NULL
      OR jsonb_typeof("requestedUserInfoClaims") = 'array'
    );

CREATE TABLE "oauthClientAssertion" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);

CREATE INDEX oauth_client_assertion_expires_at_idx
  ON "oauthClientAssertion" ("expiresAt");
