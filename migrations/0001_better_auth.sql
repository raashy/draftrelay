-- Better Auth 1.6.23 core plus the passkey, OAuth provider, JWT-key,
-- database rate-limit, and Stripe subscription plugin tables used by the cloud app.
--
-- Better Auth's default PostgreSQL adapter uses quoted singular table names and
-- quoted camelCase field names. Keep these names stable unless auth.ts supplies
-- an explicit schema mapping at the same time.

CREATE TABLE "user" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stripeCustomerId" text
);

CREATE UNIQUE INDEX user_stripe_customer_id_idx
  ON "user" ("stripeCustomerId")
  WHERE "stripeCustomerId" IS NOT NULL;

CREATE TABLE "session" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX session_user_id_idx ON "session" ("userId");
CREATE INDEX session_expires_at_idx ON "session" ("expiresAt");

CREATE TABLE "account" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  CONSTRAINT account_provider_identity_unique UNIQUE ("providerId", "accountId")
);

CREATE INDEX account_user_id_idx ON "account" ("userId");

CREATE TABLE "verification" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX verification_identifier_idx ON "verification" ("identifier");
CREATE INDEX verification_expires_at_idx ON "verification" ("expiresAt");

CREATE TABLE "passkey" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "name" text,
  "publicKey" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" text NOT NULL UNIQUE,
  "counter" integer NOT NULL CHECK ("counter" >= 0),
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" text,
  "createdAt" timestamptz,
  "aaguid" text
);

CREATE INDEX passkey_user_id_idx ON "passkey" ("userId");

-- The OAuth provider uses Better Auth's JWT plugin by default. The plugin owns
-- this signing-key table even though it is not part of oauthProvider.schema.
CREATE TABLE "jwks" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz
);

CREATE INDEX jwks_expires_at_idx ON "jwks" ("expiresAt");

CREATE TABLE "oauthClient" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb CHECK ("scopes" IS NULL OR jsonb_typeof("scopes") = 'array'),
  "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb CHECK ("contacts" IS NULL OR jsonb_typeof("contacts") = 'array'),
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb NOT NULL CHECK (jsonb_typeof("redirectUris") = 'array'),
  "postLogoutRedirectUris" jsonb
    CHECK ("postLogoutRedirectUris" IS NULL OR jsonb_typeof("postLogoutRedirectUris") = 'array'),
  "tokenEndpointAuthMethod" text,
  "grantTypes" jsonb CHECK ("grantTypes" IS NULL OR jsonb_typeof("grantTypes") = 'array'),
  "responseTypes" jsonb CHECK ("responseTypes" IS NULL OR jsonb_typeof("responseTypes") = 'array'),
  "public" boolean,
  "type" text,
  "requirePKCE" boolean,
  "referenceId" text,
  "metadata" jsonb CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);

CREATE INDEX oauth_client_user_id_idx ON "oauthClient" ("userId");
CREATE INDEX oauth_client_reference_id_idx ON "oauthClient" ("referenceId");

CREATE TABLE "oauthRefreshToken" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" uuid REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "authTime" timestamptz,
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes") = 'array')
);

CREATE INDEX oauth_refresh_token_client_id_idx ON "oauthRefreshToken" ("clientId");
CREATE INDEX oauth_refresh_token_session_id_idx ON "oauthRefreshToken" ("sessionId");
CREATE INDEX oauth_refresh_token_user_id_idx ON "oauthRefreshToken" ("userId");
CREATE INDEX oauth_refresh_token_reference_id_idx ON "oauthRefreshToken" ("referenceId");
CREATE INDEX oauth_refresh_token_expires_at_idx ON "oauthRefreshToken" ("expiresAt");

CREATE TABLE "oauthAccessToken" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" uuid REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "refreshId" uuid REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes") = 'array')
);

CREATE INDEX oauth_access_token_client_id_idx ON "oauthAccessToken" ("clientId");
CREATE INDEX oauth_access_token_session_id_idx ON "oauthAccessToken" ("sessionId");
CREATE INDEX oauth_access_token_user_id_idx ON "oauthAccessToken" ("userId");
CREATE INDEX oauth_access_token_reference_id_idx ON "oauthAccessToken" ("referenceId");
CREATE INDEX oauth_access_token_refresh_id_idx ON "oauthAccessToken" ("refreshId");
CREATE INDEX oauth_access_token_expires_at_idx ON "oauthAccessToken" ("expiresAt");

CREATE TABLE "oauthConsent" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes") = 'array'),
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX oauth_consent_client_id_idx ON "oauthConsent" ("clientId");
CREATE INDEX oauth_consent_user_id_idx ON "oauthConsent" ("userId");
CREATE INDEX oauth_consent_reference_id_idx ON "oauthConsent" ("referenceId");
CREATE UNIQUE INDEX oauth_consent_principal_unique_idx
  ON "oauthConsent" (
    "clientId",
    COALESCE("userId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("referenceId", '')
  );

CREATE TABLE "subscription" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "plan" text NOT NULL,
  "referenceId" text NOT NULL,
  "stripeCustomerId" text,
  "stripeSubscriptionId" text,
  "status" text NOT NULL,
  "periodStart" timestamptz,
  "periodEnd" timestamptz,
  "trialStart" timestamptz,
  "trialEnd" timestamptz,
  "cancelAtPeriodEnd" boolean,
  "cancelAt" timestamptz,
  "canceledAt" timestamptz,
  "endedAt" timestamptz,
  "seats" integer CHECK ("seats" IS NULL OR "seats" >= 0),
  "billingInterval" text,
  "stripeScheduleId" text
);

CREATE INDEX subscription_reference_id_idx ON "subscription" ("referenceId");
CREATE INDEX subscription_customer_id_idx ON "subscription" ("stripeCustomerId");
CREATE UNIQUE INDEX subscription_stripe_id_idx
  ON "subscription" ("stripeSubscriptionId")
  WHERE "stripeSubscriptionId" IS NOT NULL;

CREATE TABLE "rateLimit" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL CHECK ("count" >= 0),
  "lastRequest" bigint NOT NULL
);
