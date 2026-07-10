import { randomUUID } from "node:crypto";

import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { captcha, jwt } from "better-auth/plugins";
import type { Pool } from "pg";
import type Stripe from "stripe";

import type { CloudConfig } from "./config.js";
import {
  createEmailSender,
  resetPasswordEmail,
  verificationEmail
} from "./email.js";
import {
  createStripeClient,
  isStripeResourceMissing
} from "./stripe-billing.js";

const ARGON2_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 2,
  outputLen: 32,
  algorithm: 2
} as const;

async function deleteStripeResources(
  database: Pool,
  stripeClient: Stripe,
  userId: string
): Promise<void> {
  const subscriptions = await database.query<{ stripeSubscriptionId: string | null }>(
    `SELECT DISTINCT "stripeSubscriptionId"
     FROM subscription
     WHERE "referenceId" = $1
       AND status NOT IN ('canceled', 'incomplete_expired')`,
    [userId]
  );
  for (const subscription of subscriptions.rows) {
    if (!subscription.stripeSubscriptionId) continue;
    try {
      await stripeClient.subscriptions.cancel(subscription.stripeSubscriptionId);
    } catch (error: unknown) {
      if (!isStripeResourceMissing(error)) throw error;
    }
  }
  const customer = await database.query<{ stripeCustomerId: string | null }>(
    `SELECT "stripeCustomerId" FROM "user" WHERE id = $1::uuid`,
    [userId]
  );
  if (!customer.rows[0]?.stripeCustomerId) return;
  try {
    await stripeClient.customers.del(customer.rows[0].stripeCustomerId);
  } catch (error: unknown) {
    if (!isStripeResourceMissing(error)) throw error;
  }
}

async function beginAccountDeletion(database: Pool, userId: string): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`stripe-checkout:${userId}`]
    );
    await client.query(
      `INSERT INTO account_deletion_guard (user_id)
       VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearAccountDeletion(database: Pool, userId: string): Promise<void> {
  await database.query(`DELETE FROM account_deletion_guard WHERE user_id = $1::uuid`, [userId]);
}

export function createCloudAuth(
  config: CloudConfig,
  database: Pool,
  stripeClient: Stripe = createStripeClient(config)
) {
  const sendEmail = createEmailSender(config);

  return betterAuth({
    appName: config.appName,
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database,
    trustedOrigins: config.trustedOrigins,
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await beginAccountDeletion(database, user.id);
          try {
            await deleteStripeResources(database, stripeClient, user.id);
          } catch (error: unknown) {
            await clearAccountDeletion(database, user.id).catch(() => undefined);
            throw error;
          }
        }
      }
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: config.environment === "production",
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password) => hash(password, ARGON2_OPTIONS),
        verify: ({ password, hash: digest }) => verify(digest, password, ARGON2_OPTIONS)
      },
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(resetPasswordEmail(config.appName, user.email, url));
      }
    },
    emailVerification: {
      sendOnSignUp: config.environment === "production",
      autoSignInAfterVerification: true,
      expiresIn: 15 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(verificationEmail(config.appName, user.email, url));
      }
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 5 * 60,
      cookieCache: { enabled: false }
    },
    verification: {
      storeIdentifier: "hashed"
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/sign-in/passkey": { window: 60, max: 12 },
        "/oauth2/register": { window: 60 * 60, max: 20 },
        "/oauth2/token": { window: 60, max: 60 }
      }
    },
    advanced: {
      useSecureCookies: config.environment === "production",
      cookiePrefix: "draftrelay",
      // A custom UUID generator keeps ordinary auth IDs compatible with the
      // UUID columns while allowing OAuth 1.7's forceAllowId records to retain
      // their deterministic text IDs for replay protection and link identity.
      database: { generateId: () => randomUUID() },
      ipAddress: {
        // Express resolves request.ip from the socket and the exact configured
        // proxy hops, then overwrites this private header before auth runs.
        // Never trust a client-supplied forwarding header directly here.
        ipAddressHeaders: ["x-draftrelay-client-ip"],
        ipv6Subnet: 64
      }
    },
    plugins: [
      ...(config.turnstile
        ? [captcha({
            provider: "cloudflare-turnstile",
            secretKey: config.turnstile.secretKey,
            endpoints: ["/sign-up/email"],
            expectedAction: "signup",
            allowedHostnames: [config.passkeyRpId]
          })]
        : []),
      passkey({
        rpID: config.passkeyRpId,
        rpName: config.appName,
        origin: config.appUrl,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required"
        }
      }),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        signup: { page: "/signup" },
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "outputs:read",
          "outputs:write",
          "outputs:use"
        ],
        resources: [{
          identifier: config.mcpUrl,
          name: `${config.appName} MCP`,
          accessTokenTtl: 15 * 60,
          refreshTokenTtl: 60 * 60 * 24 * 30,
          allowedScopes: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "outputs:read",
            "outputs:write",
            "outputs:use"
          ],
          dpopBoundAccessTokensRequired: false
        }],
        resourceSeedMode: "insertOnly",
        // DraftRelay has one public MCP resource. Standard DCR clients do not
        // reliably create provider-specific client/resource link rows, so all
        // registered clients may request this one enabled, scoped resource.
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [
          "openid",
          "offline_access",
          "outputs:read",
          "outputs:write",
          "outputs:use"
        ],
        accessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        codeExpiresIn: 5 * 60,
        silenceWarnings: { oauthAuthServerConfig: true },
        advertisedMetadata: {
          scopes_supported: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "outputs:read",
            "outputs:write",
            "outputs:use"
          ]
        }
      }),
      stripePlugin({
        stripeClient,
        stripeWebhookSecret:
          config.stripe?.webhookSecret ?? "whsec_draftrelay_not_configured",
        createCustomerOnSignUp: false,
        getCustomerCreateParams: async (user) => ({
          metadata: { draftrelay_user_id: user.id }
        }),
        subscription: {
          enabled: true,
          requireEmailVerification: config.environment === "production",
          plans: [
            {
              name: "pro",
              lookupKey: config.stripe?.monthlyLookupKey ?? "draftrelay_pro_monthly",
              annualDiscountLookupKey:
                config.stripe?.yearlyLookupKey ?? "draftrelay_pro_yearly",
              limits: { ...config.limits.paid }
            }
          ],
          authorizeReference: async ({ user, referenceId }) => referenceId === user.id,
          getCheckoutSessionParams: async ({ subscription }) => ({
            params: {
              allow_promotion_codes: false,
              billing_address_collection: "auto",
              automatic_tax: { enabled: true },
              customer_update: { address: "auto", name: "auto" }
            },
            options: {
              idempotencyKey: `draftrelay-checkout-${subscription.id}`
            }
          })
        }
      })
    ]
  });
}

export type CloudAuth = ReturnType<typeof createCloudAuth>;

export const cloudAuthInternals = {
  ARGON2_OPTIONS,
  beginAccountDeletion,
  clearAccountDeletion,
  deleteStripeResources
};
