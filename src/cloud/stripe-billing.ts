import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Logger } from "pino";
import type { Pool, PoolClient } from "pg";
import Stripe from "stripe";
import { z } from "zod";

import type { CloudAuth } from "./auth.js";
import type { CloudConfig } from "./config.js";

export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;

const RETRY_INTERVAL_MS = 30_000;
const STALE_PROCESSING_MS = 5 * 60_000;
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;
const MAX_WEBHOOK_ATTEMPTS = 8;
const MAX_STRIPE_LIST_PAGES = 10;
const CHECKOUT_METADATA_MARKER = "draftrelay_subscription_v1";
const NONTERMINAL_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  "active", "trialing", "past_due", "unpaid", "paused", "incomplete"
]);
const PERMANENT_WEBHOOK_FAILURES = new Set([
  "stripe_subscription_customer_missing",
  "stripe_customer_mismatch",
  "stripe_subscription_owner_mismatch",
  "stripe_price_not_configured",
  "stripe_subscription_item_missing"
]);

class StripeDeadLetterError extends Error {}

export interface StripeCatalog {
  monthlyPriceId: string;
  yearlyPriceId: string;
  productId: string;
  livemode: boolean;
  validatedAt: number;
}

interface SubscriptionItemSnapshot {
  priceId: string;
  productId: string;
  active: boolean;
  currency: string;
  unitAmount: number | null;
  interval: Stripe.Price.Recurring.Interval | null;
  intervalCount: number | null;
  quantity: number | null;
  periodStart: number | null;
  periodEnd: number | null;
}

interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  referenceId: string | null;
  localSubscriptionId: string | null;
  items: SubscriptionItemSnapshot[];
  trialStart: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  endedAt: number | null;
  scheduleId: string | null;
}

interface StoredStripeEventPayload {
  schemaVersion: 1;
  event: {
    id: string;
    type: string;
    apiVersion: string | null;
    created: number;
    livemode: boolean;
    requestId: string | null;
  };
  subscriptionId: string | null;
  checkoutSessionId: string | null;
  subscription: SubscriptionSnapshot | null;
}

interface WebhookRow {
  status: "pending" | "processing" | "succeeded" | "failed" | "ignored";
  attempts: number;
  payload: StoredStripeEventPayload;
}

interface ExistingSubscriptionRow {
  id: string;
  referenceId: string;
  plan: string;
  stripeEventCreated: string | null;
}

interface UserBillingRow {
  id: string;
  stripeCustomerId: string | null;
}

export type StripeApi = Pick<
  Stripe,
  "prices" | "products" | "subscriptions" | "customers" | "checkout" | "webhooks"
>;

export interface StripeBillingService {
  webhookHandler: RequestHandler;
  ready: () => Promise<void>;
  retryDue: () => Promise<void>;
  reconcileDue: () => Promise<void>;
  reconcileUser: (userId: string) => Promise<void>;
  replay: (eventId: string) => Promise<void>;
  close: () => void;
  catalog: () => StripeCatalog;
}

export function createStripeClient(config: CloudConfig): Stripe {
  return new Stripe(
    config.stripe?.secretKey ?? "sk_test_x",
    { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 10_000 }
  );
}

const checkoutBodySchema = z.object({
  plan: z.literal("pro"),
  annual: z.boolean().optional().default(false),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  returnUrl: z.string().url().optional(),
  disableRedirect: z.boolean().optional().default(false)
});

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

type CheckoutReuseDecision =
  | { kind: "ignore" }
  | { kind: "reuse"; session: Stripe.Checkout.Session }
  | { kind: "expire" }
  | { kind: "fail_closed" };

function stripeCustomerId(session: Stripe.Checkout.Session): string | null {
  if (typeof session.customer === "string") return session.customer;
  return session.customer?.id ?? null;
}

function inspectCheckoutForReuse(
  session: Stripe.Checkout.Session,
  expected: {
    userId: string;
    customerId: string;
    catalog: StripeCatalog;
    now: number;
  }
): CheckoutReuseDecision {
  if (session.metadata?.draftrelay_checkout !== CHECKOUT_METADATA_MARKER) {
    return { kind: "fail_closed" };
  }
  if (session.status !== "open" || session.expires_at <= expected.now) {
    return { kind: "ignore" };
  }
  if (
    session.mode !== "subscription" ||
    session.client_reference_id !== expected.userId ||
    session.metadata.userId !== expected.userId ||
    session.metadata.referenceId !== expected.userId ||
    stripeCustomerId(session) !== expected.customerId ||
    session.livemode !== expected.catalog.livemode ||
    !session.url
  ) {
    return { kind: "fail_closed" };
  }

  const lineItems = session.line_items;
  if (
    !lineItems ||
    lineItems.object !== "list" ||
    lineItems.has_more !== false ||
    !Array.isArray(lineItems.data) ||
    lineItems.data.length !== 1
  ) {
    return { kind: "fail_closed" };
  }
  const lineItem = lineItems.data[0];
  if (
    !lineItem ||
    lineItem.quantity !== 1 ||
    !lineItem.price ||
    typeof lineItem.price !== "object"
  ) {
    return { kind: "fail_closed" };
  }

  const expectedInterval = lineItem.price.id === expected.catalog.monthlyPriceId
    ? "month"
    : lineItem.price.id === expected.catalog.yearlyPriceId
      ? "year"
      : null;
  const productId = typeof lineItem.price.product === "string"
    ? lineItem.price.product
    : lineItem.price.product.id;
  if (
    !expectedInterval ||
    !lineItem.price.active ||
    lineItem.price.livemode !== expected.catalog.livemode ||
    lineItem.price.type !== "recurring" ||
    lineItem.price.recurring?.interval !== expectedInterval ||
    lineItem.price.recurring.interval_count !== 1 ||
    productId !== expected.catalog.productId ||
    session.metadata.billingInterval !== expectedInterval
  ) {
    return { kind: "expire" };
  }
  return { kind: "reuse", session };
}

export function createStripeCheckoutHandler(
  config: CloudConfig,
  database: Pool,
  auth: CloudAuth,
  stripeClient: StripeApi,
  catalog: () => StripeCatalog
): RequestHandler {
  return async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (
      request.get("origin") !== config.appUrl ||
      request.get("sec-fetch-site") === "cross-site"
    ) {
      response.status(403).json({ error: { code: "checkout_origin_rejected" } });
      return;
    }
    const parsed = checkoutBodySchema.safeParse(request.body);
    if (!parsed.success || ![
      parsed.data.successUrl,
      parsed.data.cancelUrl,
      parsed.data.returnUrl
    ].filter((value): value is string => Boolean(value)).every((value) => sameOrigin(value, config.appUrl))) {
      response.status(400).json({ error: { code: "invalid_checkout_request" } });
      return;
    }
    const headers = fromNodeHeaders(request.headers);
    const session = await auth.api.getSession({ headers });
    if (!session) {
      response.status(401).json({ error: { code: "unauthorized" } });
      return;
    }
    if (config.environment === "production" && !session.user.emailVerified) {
      response.status(403).json({ error: { code: "email_verification_required" } });
      return;
    }

    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`stripe-checkout:${session.user.id}`]
      );
      const deletion = await client.query(
        `SELECT 1 FROM account_deletion_guard WHERE user_id = $1::uuid`,
        [session.user.id]
      );
      if (deletion.rowCount) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: { code: "account_deletion_in_progress" } });
        return;
      }
      const customer = await client.query<{
        stripeCustomerId: string | null;
        email: string;
        name: string;
      }>(
        `SELECT "stripeCustomerId", email, name FROM "user"
         WHERE id = $1::uuid FOR UPDATE`,
        [session.user.id]
      );
      const user = customer.rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        response.status(401).json({ error: { code: "unauthorized" } });
        return;
      }
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const created = await stripeClient.customers.create({
          email: user.email,
          name: user.name,
          metadata: { draftrelay_user_id: session.user.id }
        }, {
          idempotencyKey: `draftrelay-customer-${session.user.id}`
        });
        customerId = created.id;
        await client.query(
          `UPDATE "user" SET "stripeCustomerId" = $2, "updatedAt" = CURRENT_TIMESTAMP
           WHERE id = $1::uuid`,
          [session.user.id, customerId]
        );
      }

      let hasRemoteSubscription = false;
      let subscriptionCursor: string | undefined;
      let subscriptionPages = 0;
      let subscriptionInventoryComplete = true;
      do {
        subscriptionPages += 1;
        const remoteSubscriptions = await stripeClient.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 100,
          ...(subscriptionCursor ? { starting_after: subscriptionCursor } : {})
        });
        hasRemoteSubscription = remoteSubscriptions.data.some((subscription) =>
          NONTERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)
        );
        if (
          remoteSubscriptions.has_more &&
          subscriptionPages >= MAX_STRIPE_LIST_PAGES &&
          !hasRemoteSubscription
        ) {
          subscriptionInventoryComplete = false;
          break;
        }
        subscriptionCursor = remoteSubscriptions.has_more
          ? remoteSubscriptions.data.at(-1)?.id
          : undefined;
        if (remoteSubscriptions.has_more && !subscriptionCursor && !hasRemoteSubscription) {
          subscriptionInventoryComplete = false;
          break;
        }
        if (hasRemoteSubscription || !remoteSubscriptions.has_more || !subscriptionCursor) break;
      } while (subscriptionCursor);
      if (!subscriptionInventoryComplete) {
        await client.query("ROLLBACK");
        response.status(503).json({ error: { code: "billing_inventory_incomplete" } });
        return;
      }
      if (hasRemoteSubscription) {
        await client.query("ROLLBACK");
        response.status(409).json({
          error: {
            code: "subscription_already_exists",
            message: "Manage the existing subscription before starting another checkout."
          }
        });
        return;
      }

      const interval = parsed.data.annual ? "year" : "month";
      const now = Math.floor(Date.now() / 1_000);
      const currentCatalog = catalog();
      let existing: Stripe.Checkout.Session | undefined;
      let checkoutValidationFailed = false;
      let checkoutCursor: string | undefined;
      let checkoutPages = 0;
      let checkoutInventoryComplete = true;
      do {
        checkoutPages += 1;
        const openSessions = await stripeClient.checkout.sessions.list({
          customer: customerId,
          status: "open",
          limit: 100,
          ...(checkoutCursor ? { starting_after: checkoutCursor } : {})
        });
        for (const candidate of openSessions.data) {
          if (candidate.metadata?.draftrelay_checkout !== CHECKOUT_METADATA_MARKER) continue;
          const authoritative = await stripeClient.checkout.sessions.retrieve(candidate.id, {
            expand: ["line_items.data.price"]
          });
          const decision = inspectCheckoutForReuse(authoritative, {
            userId: session.user.id,
            customerId,
            catalog: currentCatalog,
            now
          });
          if (decision.kind === "reuse") {
            existing = decision.session;
            break;
          }
          if (decision.kind === "expire") {
            const expired = await stripeClient.checkout.sessions.expire(authoritative.id);
            if (expired.status !== "expired") {
              checkoutValidationFailed = true;
              break;
            }
          } else if (decision.kind === "fail_closed") {
            checkoutValidationFailed = true;
            break;
          }
        }
        if (checkoutValidationFailed) break;
        if (
          openSessions.has_more &&
          checkoutPages >= MAX_STRIPE_LIST_PAGES &&
          !existing
        ) {
          checkoutInventoryComplete = false;
          break;
        }
        checkoutCursor = openSessions.has_more
          ? openSessions.data.at(-1)?.id
          : undefined;
        if (openSessions.has_more && !checkoutCursor && !existing) {
          checkoutInventoryComplete = false;
          break;
        }
        if (existing || !openSessions.has_more || !checkoutCursor) break;
      } while (checkoutCursor);
      if (checkoutValidationFailed) {
        await client.query("ROLLBACK");
        response.status(503).json({ error: { code: "billing_checkout_validation_failed" } });
        return;
      }
      if (!checkoutInventoryComplete) {
        await client.query("ROLLBACK");
        response.status(503).json({ error: { code: "billing_inventory_incomplete" } });
        return;
      }
      if (existing?.url) {
        await client.query("COMMIT");
        response.json({
          url: existing.url,
          redirect: !parsed.data.disableRedirect,
          reused: true
        });
        return;
      }

      await client.query(
        `UPDATE subscription SET status = 'canceled'
         WHERE "referenceId" = $1 AND status IN (
           'active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'
         )`,
        [session.user.id]
      );
      const localSubscriptionId = randomUUID();
      await client.query(
        `INSERT INTO subscription (
           id, plan, "referenceId", "stripeCustomerId", status, seats, "billingInterval"
         ) VALUES ($1::uuid, 'pro', $2, $3, 'incomplete', 1, $4)`,
        [localSubscriptionId, session.user.id, customerId, interval]
      );
      const checkout = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: session.user.id,
        line_items: [{
          price: parsed.data.annual
            ? currentCatalog.yearlyPriceId
            : currentCatalog.monthlyPriceId,
          quantity: 1
        }],
        allow_promotion_codes: false,
        billing_address_collection: "auto",
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        success_url: parsed.data.successUrl,
        cancel_url: parsed.data.cancelUrl,
        metadata: {
          draftrelay_checkout: CHECKOUT_METADATA_MARKER,
          userId: session.user.id,
          referenceId: session.user.id,
          subscriptionId: localSubscriptionId,
          billingInterval: interval
        },
        subscription_data: {
          metadata: {
            userId: session.user.id,
            referenceId: session.user.id,
            subscriptionId: localSubscriptionId
          }
        }
      }, {
        idempotencyKey: `draftrelay-checkout-${localSubscriptionId}`
      });
      if (!checkout.url) throw new Error("stripe_checkout_url_missing");
      await client.query("COMMIT");
      response.json({
        url: checkout.url,
        redirect: !parsed.data.disableRedirect,
        reused: false
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      next(error);
    } finally {
      client.release();
    }
  };
}

function priceProductId(price: Stripe.Price): string {
  return typeof price.product === "string" ? price.product : price.product.id;
}

async function oneConfiguredPrice(
  client: StripeApi,
  lookupKey: string,
  expected: { amount: number; interval: "month" | "year"; livemode: boolean }
): Promise<Stripe.Price> {
  const result = await client.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 10
  });
  if (result.data.length !== 1) {
    throw new Error(`Stripe lookup key ${lookupKey} must resolve to exactly one active Price`);
  }
  const price = result.data[0];
  if (!price) throw new Error(`Stripe lookup key ${lookupKey} did not resolve to a Price`);
  if (
    !price.active || price.livemode !== expected.livemode || price.type !== "recurring" ||
    price.currency !== "usd" || price.unit_amount !== expected.amount ||
    price.recurring?.interval !== expected.interval || price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed"
  ) {
    throw new Error(
      `Stripe lookup key ${lookupKey} must be an active ${expected.livemode ? "live" : "test"} ` +
      `USD ${expected.amount} recurring ${expected.interval} Price`
    );
  }
  return price;
}

export async function validateStripeCatalog(
  config: CloudConfig,
  client: StripeApi
): Promise<StripeCatalog> {
  if (!config.stripe) throw new Error("Stripe is not configured");
  const livemode = config.environment === "production";
  const [monthly, yearly] = await Promise.all([
    oneConfiguredPrice(client, config.stripe.monthlyLookupKey, {
      amount: 100,
      interval: "month",
      livemode
    }),
    oneConfiguredPrice(client, config.stripe.yearlyLookupKey, {
      amount: 1_000,
      interval: "year",
      livemode
    })
  ]);
  const productId = priceProductId(monthly);
  if (priceProductId(yearly) !== productId) {
    throw new Error("Stripe monthly and yearly Prices must belong to the same Product");
  }
  const product = await client.products.retrieve(productId);
  if ("deleted" in product && product.deleted) {
    throw new Error("Stripe Pro Product is deleted");
  }
  if (!product.active || product.livemode !== livemode) {
    throw new Error(`Stripe Pro Product must be active in ${livemode ? "live" : "test"} mode`);
  }
  return {
    monthlyPriceId: monthly.id,
    yearlyPriceId: yearly.id,
    productId,
    livemode,
    validatedAt: Date.now()
  };
}

function idOf(value: string | { id: string } | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.id;
}

function subscriptionSnapshot(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const customerId = idOf(subscription.customer);
  if (!customerId) throw new Error("stripe_subscription_customer_missing");
  return {
    id: subscription.id,
    customerId,
    status: subscription.status,
    referenceId: subscription.metadata.referenceId ?? null,
    localSubscriptionId: subscription.metadata.subscriptionId ?? null,
    items: subscription.items.data.map((item) => ({
      priceId: item.price.id,
      productId: priceProductId(item.price),
      active: item.price.active,
      currency: item.price.currency,
      unitAmount: item.price.unit_amount,
      interval: item.price.recurring?.interval ?? null,
      intervalCount: item.price.recurring?.interval_count ?? null,
      quantity: item.quantity ?? null,
      periodStart: item.current_period_start ?? null,
      periodEnd: item.current_period_end ?? null
    })),
    trialStart: subscription.trial_start,
    trialEnd: subscription.trial_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at,
    canceledAt: subscription.canceled_at,
    endedAt: subscription.ended_at,
    scheduleId: idOf(subscription.schedule)
  };
}

function eventSubscriptionId(event: Stripe.Event): string | null {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    return idOf(session.subscription);
  }
  if (event.type.startsWith("customer.subscription.")) {
    return (event.data.object as Stripe.Subscription).id;
  }
  return null;
}

function storedPayload(event: Stripe.Event): StoredStripeEventPayload {
  const subscription = event.type.startsWith("customer.subscription.")
    ? subscriptionSnapshot(event.data.object as Stripe.Subscription)
    : null;
  return {
    schemaVersion: 1,
    event: {
      id: event.id,
      type: event.type,
      apiVersion: event.api_version,
      created: event.created,
      livemode: event.livemode,
      requestId: event.request?.id ?? null
    },
    subscriptionId: eventSubscriptionId(event),
    checkoutSessionId: event.type === "checkout.session.completed"
      ? (event.data.object as Stripe.Checkout.Session).id
      : null,
    subscription
  };
}

function isUuid(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function epochDate(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1_000);
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_SECONDS, 30 * 2 ** Math.min(Math.max(attempts - 1, 0), 7));
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && PERMANENT_WEBHOOK_FAILURES.has(error.message)) return error.message;
  return "stripe_reconciliation_failed";
}

export function isStripeResourceMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; statusCode?: unknown; type?: unknown };
  return candidate.code === "resource_missing" || candidate.statusCode === 404;
}

async function transaction<T>(database: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function withSubscriptionTransaction<T>(
  database: Pool,
  subscriptionId: string,
  run: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await database.connect();
  const key = `stripe-subscription:${subscriptionId}`;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileSubscriptionOnClient(
  client: PoolClient,
  catalog: StripeCatalog,
  snapshot: SubscriptionSnapshot,
  eventCreated: number | null
): Promise<{ ignored: boolean; recognized: boolean }> {
    const existingResult = await client.query<ExistingSubscriptionRow>(
      `SELECT id, "referenceId", plan, "stripeEventCreated" FROM subscription
       WHERE "stripeSubscriptionId" = $1 FOR UPDATE`,
      [snapshot.id]
    );
    const existing = existingResult.rows[0];

    let user: UserBillingRow | undefined;
    const referenceId = existing?.referenceId ?? snapshot.referenceId;
    if (isUuid(referenceId)) {
      const userResult = await client.query<UserBillingRow>(
        `SELECT id, "stripeCustomerId" FROM "user" WHERE id = $1::uuid FOR UPDATE`,
        [referenceId]
      );
      user = userResult.rows[0];
    }
    if (!user) {
      const userResult = await client.query<UserBillingRow>(
        `SELECT id, "stripeCustomerId" FROM "user" WHERE "stripeCustomerId" = $1 FOR UPDATE`,
        [snapshot.customerId]
      );
      user = userResult.rows[0];
    }
    if (!user) return { ignored: true, recognized: true };
    if (!user.stripeCustomerId || user.stripeCustomerId !== snapshot.customerId) {
      throw new Error("stripe_customer_mismatch");
    }

    const configuredItem = snapshot.items.find((item) =>
      item.productId === catalog.productId && item.active && item.currency === "usd" &&
      item.intervalCount === 1 && (
        (item.priceId === catalog.monthlyPriceId && item.unitAmount === 100 && item.interval === "month") ||
        (item.priceId === catalog.yearlyPriceId && item.unitAmount === 1_000 && item.interval === "year")
      )
    );
    if (!configuredItem && !existing) throw new Error("stripe_price_not_configured");
    const billingItem = configuredItem ?? snapshot.items[0];
    if (!billingItem) throw new Error("stripe_subscription_item_missing");

    let localId = existing?.id;
    if (!localId && isUuid(snapshot.localSubscriptionId)) {
      const localResult = await client.query<{ id: string }>(
        `SELECT id FROM subscription
         WHERE id = $1::uuid AND "referenceId" = $2::text
           AND ("stripeSubscriptionId" IS NULL OR "stripeSubscriptionId" = $3)
         FOR UPDATE`,
        [snapshot.localSubscriptionId, user.id, snapshot.id]
      );
      localId = localResult.rows[0]?.id;
    }
    localId ??= randomUUID();
    const values = [
      localId,
      user.id,
      snapshot.customerId,
      snapshot.id,
      snapshot.status,
      epochDate(billingItem.periodStart),
      epochDate(billingItem.periodEnd),
      epochDate(snapshot.trialStart),
      epochDate(snapshot.trialEnd),
      snapshot.cancelAtPeriodEnd,
      epochDate(snapshot.cancelAt),
      epochDate(snapshot.canceledAt),
      epochDate(snapshot.endedAt),
      billingItem.quantity ?? 1,
      billingItem.interval,
      snapshot.scheduleId,
      configuredItem ? "pro" : "unrecognized",
      eventCreated
    ];
    const updated = await client.query(
      `UPDATE subscription SET
         plan = $17, "referenceId" = $2, "stripeCustomerId" = $3,
         "stripeSubscriptionId" = $4, status = $5, "periodStart" = $6,
         "periodEnd" = $7, "trialStart" = $8, "trialEnd" = $9,
         "cancelAtPeriodEnd" = $10, "cancelAt" = $11, "canceledAt" = $12,
         "endedAt" = $13, seats = $14, "billingInterval" = $15,
         "stripeScheduleId" = $16, "stripeSyncedAt" = CURRENT_TIMESTAMP,
         "stripeEventCreated" = CASE WHEN $18::bigint IS NULL
           THEN "stripeEventCreated"
           ELSE GREATEST(COALESCE("stripeEventCreated", $18::bigint), $18::bigint) END
       WHERE id = $1::uuid`,
      values
    );
    if (updated.rowCount === 0) {
      const inserted = await client.query(
        `INSERT INTO subscription (
           id, plan, "referenceId", "stripeCustomerId", "stripeSubscriptionId",
           status, "periodStart", "periodEnd", "trialStart", "trialEnd",
           "cancelAtPeriodEnd", "cancelAt", "canceledAt", "endedAt", seats,
           "billingInterval", "stripeScheduleId", "stripeSyncedAt", "stripeEventCreated"
         ) VALUES ($1::uuid, $17, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP, $18::bigint)
         ON CONFLICT ("stripeSubscriptionId")
           WHERE "stripeSubscriptionId" IS NOT NULL
         DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status,
           "periodStart" = EXCLUDED."periodStart",
           "periodEnd" = EXCLUDED."periodEnd", "cancelAtPeriodEnd" = EXCLUDED."cancelAtPeriodEnd",
           "cancelAt" = EXCLUDED."cancelAt", "canceledAt" = EXCLUDED."canceledAt",
           "endedAt" = EXCLUDED."endedAt", seats = EXCLUDED.seats,
           "billingInterval" = EXCLUDED."billingInterval",
           "stripeScheduleId" = EXCLUDED."stripeScheduleId",
           "stripeSyncedAt" = CURRENT_TIMESTAMP,
           "stripeEventCreated" = GREATEST(
             COALESCE(subscription."stripeEventCreated", EXCLUDED."stripeEventCreated"),
             EXCLUDED."stripeEventCreated"
           )
         WHERE subscription."referenceId" = EXCLUDED."referenceId"
           AND subscription."stripeCustomerId" = EXCLUDED."stripeCustomerId"`,
        values
      );
      if (inserted.rowCount !== 1) {
        throw new Error("stripe_subscription_owner_mismatch");
      }
    }
    return { ignored: false, recognized: Boolean(configuredItem) };
}

async function reconcileSubscription(
  database: Pool,
  catalog: StripeCatalog,
  snapshot: SubscriptionSnapshot,
  eventCreated: number | null = null
): Promise<{ ignored: boolean; recognized: boolean }> {
  return transaction(database, (client) =>
    reconcileSubscriptionOnClient(client, catalog, snapshot, eventCreated)
  );
}

export async function createStripeBillingService(
  config: CloudConfig,
  database: Pool,
  logger: Pick<Logger, "info" | "warn">,
  options: { client?: StripeApi; startWorker?: boolean } = {}
): Promise<StripeBillingService | undefined> {
  if (!config.stripe) return undefined;
  const client = options.client ?? createStripeClient(config);
  let currentCatalog = await validateStripeCatalog(config, client);

  const processEvent = async (eventId: string): Promise<void> => {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const claimed = await database.query<WebhookRow>(
      `UPDATE webhook_event SET status = 'processing', attempts = attempts + 1,
         last_error = NULL, next_attempt_at = NULL
       WHERE provider = 'stripe' AND provider_event_id = $1
         AND (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < $2))
       RETURNING status, attempts, payload`,
      [eventId, staleBefore]
    );
    const row = claimed.rows[0];
    if (!row) return;
    try {
      const reconcileCurrent = async (
        lockedClient: PoolClient
      ): Promise<{ ignored: boolean; recognized: boolean } | undefined> => {
        let snapshot: SubscriptionSnapshot | null = null;
        if (row.payload.subscriptionId) {
          try {
            const subscription = await client.subscriptions.retrieve(row.payload.subscriptionId);
            snapshot = subscriptionSnapshot(subscription);
          } catch (error: unknown) {
            if (
              isStripeResourceMissing(error) &&
              row.payload.event.type === "customer.subscription.deleted" &&
              row.payload.subscription
            ) {
              snapshot = row.payload.subscription;
            } else {
              throw error;
            }
          }
          await lockedClient.query(
            `UPDATE webhook_event
             SET payload = jsonb_set(payload, '{subscription}', $2::jsonb, true)
             WHERE provider = 'stripe' AND provider_event_id = $1`,
            [eventId, JSON.stringify(snapshot)]
          );
        } else {
          snapshot = row.payload.subscription;
        }
        if (!snapshot) return undefined;
        return reconcileSubscriptionOnClient(
          lockedClient,
          currentCatalog,
          snapshot,
          row.payload.event.created
        );
      };
      const result = row.payload.subscriptionId
        ? await withSubscriptionTransaction(database, row.payload.subscriptionId, reconcileCurrent)
        : row.payload.subscription
          ? await reconcileSubscription(
              database,
              currentCatalog,
              row.payload.subscription,
              row.payload.event.created
            )
          : undefined;
      if (!result) {
        await database.query(
          `UPDATE webhook_event SET status = 'ignored', processed_at = CURRENT_TIMESTAMP
           WHERE provider = 'stripe' AND provider_event_id = $1`,
          [eventId]
        );
        return;
      }
      if (!result.recognized) throw new Error("stripe_price_not_configured");
      await database.query(
        `UPDATE webhook_event SET status = $2, processed_at = CURRENT_TIMESTAMP,
           last_error = NULL, next_attempt_at = NULL
         WHERE provider = 'stripe' AND provider_event_id = $1`,
        [eventId, result.ignored ? "ignored" : "succeeded"]
      );
    } catch (error: unknown) {
      const code = safeFailureCode(error);
      const delaySeconds = retryDelaySeconds(row.attempts);
      const deadLetter = PERMANENT_WEBHOOK_FAILURES.has(code) || row.attempts >= MAX_WEBHOOK_ATTEMPTS;
      await database.query(
        `UPDATE webhook_event SET status = $2, last_error = $3,
           next_attempt_at = CASE WHEN $2 = 'dead_letter' THEN NULL
             ELSE CURRENT_TIMESTAMP + make_interval(secs => $4) END,
           processed_at = CASE WHEN $2 = 'dead_letter' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE provider = 'stripe' AND provider_event_id = $1`,
        [eventId, deadLetter ? "dead_letter" : "failed", code, delaySeconds]
      );
      logger.warn(
        { stripeEventId: eventId, code, deadLetter },
        deadLetter ? "Stripe webhook moved to the dead-letter queue" : "Stripe webhook reconciliation failed"
      );
      if (deadLetter) throw new StripeDeadLetterError(code);
      throw new Error(code);
    }
  };

  const retryDue = async (): Promise<void> => {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const due = await database.query<{ provider_event_id: string }>(
      `SELECT provider_event_id FROM webhook_event
       WHERE provider = 'stripe' AND (
         status = 'pending'
         OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
         OR (status = 'processing' AND updated_at < $1)
       )
       ORDER BY received_at LIMIT 20`,
      [staleBefore]
    );
    for (const event of due.rows) {
      await processEvent(event.provider_event_id).catch(() => undefined);
    }
  };

  const reconcileDue = async (): Promise<void> => {
    const due = await database.query<{ stripeSubscriptionId: string }>(
      `SELECT "stripeSubscriptionId"
       FROM subscription
       WHERE "stripeSubscriptionId" IS NOT NULL
         AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete')
         AND ("stripeSyncedAt" IS NULL OR "stripeSyncedAt" < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
       ORDER BY "stripeSyncedAt" NULLS FIRST
       LIMIT 50`
    );
    for (const row of due.rows) {
      await withSubscriptionTransaction(database, row.stripeSubscriptionId, async (lockedClient) => {
        try {
          const remote = await client.subscriptions.retrieve(row.stripeSubscriptionId);
          const result = await reconcileSubscriptionOnClient(
            lockedClient,
            currentCatalog,
            subscriptionSnapshot(remote),
            null
          );
          if (!result.recognized) {
            logger.warn(
              { stripeSubscriptionId: row.stripeSubscriptionId },
              "Stripe subscription uses an unconfigured Price and is not entitled"
            );
          }
        } catch (error: unknown) {
          if (isStripeResourceMissing(error)) {
            await lockedClient.query(
              `UPDATE subscription SET status = 'canceled', plan = 'unrecognized',
                 "stripeSyncedAt" = CURRENT_TIMESTAMP
               WHERE "stripeSubscriptionId" = $1`,
              [row.stripeSubscriptionId]
            );
            return;
          }
          throw error;
        }
      }).catch(() => {
        logger.warn(
          { stripeSubscriptionId: row.stripeSubscriptionId },
          "Periodic Stripe subscription reconciliation failed"
        );
      });
    }
  };

  const reconcileUser = async (userId: string): Promise<void> => {
    if (!isUuid(userId)) throw new Error("stripe_user_id_invalid");
    const [userResult, localResult] = await Promise.all([
      database.query<{ stripeCustomerId: string | null }>(
        `SELECT "stripeCustomerId" FROM "user" WHERE id = $1::uuid`,
        [userId]
      ),
      database.query<{ id: string; stripeSubscriptionId: string | null }>(
        `SELECT id, "stripeSubscriptionId" FROM subscription
         WHERE "referenceId" = $1
           AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete')`,
        [userId]
      )
    ]);
    const customerId = userResult.rows[0]?.stripeCustomerId;
    if (!customerId) return;

    const localIds = new Set(localResult.rows.map((row) => row.id));
    const localStripeIds = new Set(
      localResult.rows
        .map((row) => row.stripeSubscriptionId)
        .filter((id): id is string => Boolean(id))
    );
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      const remoteSubscriptions = await client.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {})
      });
      const relevant = remoteSubscriptions.data.filter((subscription) =>
        NONTERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status) ||
        localStripeIds.has(subscription.id) ||
        localIds.has(subscription.metadata.subscriptionId ?? "")
      );
      for (const remote of relevant) {
        await withSubscriptionTransaction(database, remote.id, async (lockedClient) => {
          const current = await client.subscriptions.retrieve(remote.id);
          await reconcileSubscriptionOnClient(
            lockedClient,
            currentCatalog,
            subscriptionSnapshot(current),
            null
          );
        });
      }
      if (remoteSubscriptions.has_more && pages >= MAX_STRIPE_LIST_PAGES) {
        throw new Error("stripe_subscription_inventory_incomplete");
      }
      cursor = remoteSubscriptions.has_more
        ? remoteSubscriptions.data.at(-1)?.id
        : undefined;
      if (remoteSubscriptions.has_more && !cursor) {
        throw new Error("stripe_subscription_inventory_incomplete");
      }
    } while (cursor);
  };

  const replay = async (eventId: string): Promise<void> => {
    const reset = await database.query(
      `UPDATE webhook_event SET status = 'pending', attempts = 0,
         last_error = NULL, next_attempt_at = NULL, processed_at = NULL
       WHERE provider = 'stripe' AND provider_event_id = $1
         AND status IN ('failed', 'dead_letter')`,
      [eventId]
    );
    if (reset.rowCount !== 1) throw new Error("stripe_webhook_not_replayable");
    await processEvent(eventId);
  };

  const ready = async (): Promise<void> => {
    if (Date.now() - currentCatalog.validatedAt < CATALOG_TTL_MS) return;
    currentCatalog = await validateStripeCatalog(config, client);
  };

  const webhookHandler: RequestHandler = async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const signature = request.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: { code: "invalid_stripe_webhook" } });
      return;
    }
    let event: Stripe.Event;
    try {
      event = await client.webhooks.constructEventAsync(
        request.body,
        signature,
        config.stripe!.webhookSecret
      );
    } catch {
      response.status(400).json({ error: { code: "invalid_stripe_webhook" } });
      return;
    }
    if (event.livemode !== currentCatalog.livemode) {
      response.status(400).json({ error: { code: "stripe_mode_mismatch" } });
      return;
    }
    const payload = storedPayload(event);
    await database.query(
      `INSERT INTO webhook_event (
         provider, provider_event_id, event_type, status, payload, attempts
       ) VALUES ('stripe', $1, $2, 'pending', $3::jsonb, 0)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(payload)]
    );
    response.json({ received: true });
    setImmediate(() => {
      void processEvent(event.id).catch(() => undefined);
    });
  };

  let timer: NodeJS.Timeout | undefined;
  if (options.startWorker !== false) {
    void Promise.all([retryDue(), reconcileDue()]).catch(() => undefined);
    timer = setInterval(() => {
      void Promise.all([retryDue(), reconcileDue()]).catch(() => undefined);
    }, RETRY_INTERVAL_MS);
    timer.unref();
  }
  logger.info(
    { stripeProductId: currentCatalog.productId, stripeLivemode: currentCatalog.livemode },
    "Stripe billing catalog validated"
  );
  return {
    webhookHandler,
    ready,
    retryDue,
    reconcileDue,
    reconcileUser,
    replay,
    close: () => {
      if (timer) clearInterval(timer);
    },
    catalog: () => currentCatalog
  };
}

export const stripeBillingInternals = {
  CHECKOUT_METADATA_MARKER,
  inspectCheckoutForReuse,
  oneConfiguredPrice,
  subscriptionSnapshot,
  storedPayload,
  retryDelaySeconds,
  safeFailureCode,
  reconcileSubscription
};
