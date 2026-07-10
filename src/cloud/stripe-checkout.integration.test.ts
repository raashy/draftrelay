import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import express from "express";
import { Pool } from "pg";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudAuthInternals, type CloudAuth } from "./auth.js";
import { loadCloudConfig } from "./config.js";
import {
  createStripeCheckoutHandler,
  stripeBillingInternals,
  type StripeApi,
  type StripeCatalog
} from "./stripe-billing.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

function remoteSubscription(id: string, status: Stripe.Subscription.Status): Stripe.Subscription {
  return { id, status } as Stripe.Subscription;
}

function openCheckout(
  id: string,
  userId: string,
  interval: "month" | "year",
  options: {
    customerId?: string;
    marker?: boolean;
    priceId?: string;
    malformedLineItems?: boolean;
  } = {}
): Stripe.Checkout.Session {
  const priceId = options.priceId ?? (interval === "month"
    ? "price_monthly_exact"
    : "price_yearly_exact");
  return {
    id,
    object: "checkout.session",
    mode: "subscription",
    status: "open",
    customer: options.customerId ?? `cus_${userId}`,
    client_reference_id: userId,
    livemode: false,
    metadata: {
      ...(options.marker === false
        ? {}
        : { draftrelay_checkout: stripeBillingInternals.CHECKOUT_METADATA_MARKER }),
      userId,
      referenceId: userId,
      billingInterval: interval
    },
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    url: `https://checkout.stripe.test/${id}`,
    ...(options.malformedLineItems
      ? {}
      : {
          line_items: {
            object: "list",
            data: [{
              id: `li_${id}`,
              object: "item",
              quantity: 1,
              price: {
                id: priceId,
                object: "price",
                active: true,
                currency: "usd",
                livemode: false,
                product: "prod_exact",
                recurring: {
                  interval,
                  interval_count: 1,
                  usage_type: "licensed"
                },
                type: "recurring"
              }
            }],
            has_more: false,
            url: `/v1/checkout/sessions/${id}/line_items`
          }
        })
  } as unknown as Stripe.Checkout.Session;
}

integration("owned Stripe checkout", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const config = loadCloudConfig({
    NODE_ENV: "test",
    APP_URL: "http://localhost:3941",
    DATABASE_URL: databaseUrl!,
    STRIPE_SECRET_KEY: "sk_test_checkout",
    STRIPE_WEBHOOK_SECRET: "whsec_checkout"
  });
  const productionConfig = { ...config, environment: "production" as const };
  const userId = randomUUID();
  const customerId = `cus_checkout_${userId}`;
  const catalog: StripeCatalog = {
    monthlyPriceId: "price_monthly_exact",
    yearlyPriceId: "price_yearly_exact",
    productId: "prod_exact",
    livemode: false,
    validatedAt: Date.now()
  };
  let emailVerified = true;
  let remoteSubscriptions: Stripe.Subscription[] = [];
  let openSessions: Stripe.Checkout.Session[] = [];
  let subscriptionListImpl: (
    params: Stripe.SubscriptionListParams
  ) => Promise<Stripe.ApiList<Stripe.Subscription>>;
  let checkoutListImpl: (
    params: Stripe.Checkout.SessionListParams
  ) => Promise<Stripe.ApiList<Stripe.Checkout.Session>>;
  let server: Server;
  let baseUrl: string;

  const customersCreate = vi.fn(async () => ({ id: customerId } as Stripe.Customer));
  const subscriptionsList = vi.fn((params: Stripe.SubscriptionListParams) =>
    subscriptionListImpl(params)
  );
  const checkoutList = vi.fn((params: Stripe.Checkout.SessionListParams) =>
    checkoutListImpl(params)
  );
  const checkoutCreate = vi.fn(async (
    params: Stripe.Checkout.SessionCreateParams,
    _options?: Stripe.RequestOptions
  ) => {
    const interval = params.metadata?.billingInterval;
    if (interval !== "month" && interval !== "year") {
      throw new Error("test_checkout_interval_missing");
    }
    const price = params.line_items?.[0]?.price;
    if (typeof price !== "string") throw new Error("test_checkout_price_missing");
    const value = openCheckout(`cs_${randomUUID()}`, userId, interval, {
      customerId: typeof params.customer === "string" ? params.customer : customerId,
      priceId: price
    });
    openSessions.push(value);
    return value;
  });
  const checkoutRetrieve = vi.fn(async (id: string) => {
    const value = openSessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("test_checkout_not_found");
    return value;
  });
  const checkoutExpire = vi.fn(async (id: string) => {
    const value = openSessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("test_checkout_not_found");
    value.status = "expired";
    openSessions = openSessions.filter((candidate) => candidate.id !== id);
    return value;
  });
  const stripeClient = {
    customers: { create: customersCreate },
    subscriptions: { list: subscriptionsList },
    checkout: {
      sessions: {
        list: checkoutList,
        retrieve: checkoutRetrieve,
        expire: checkoutExpire,
        create: checkoutCreate
      }
    }
  } as unknown as StripeApi;
  const auth = {
    api: {
      getSession: vi.fn(async () => ({
        user: {
          id: userId,
          name: "Checkout Test",
          email: `checkout-${userId}@example.com`,
          emailVerified
        }
      }))
    }
  } as unknown as CloudAuth;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Checkout Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, `checkout-${userId}@example.com`]
    );
    const app = express();
    app.post(
      "/checkout",
      express.json(),
      createStripeCheckoutHandler(config, pool, auth, stripeClient, () => catalog)
    );
    app.post(
      "/checkout-production",
      express.json(),
      createStripeCheckoutHandler(productionConfig, pool, auth, stripeClient, () => catalog)
    );
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM account_deletion_guard WHERE user_id = $1::uuid`, [userId]);
    await pool.query(`DELETE FROM subscription WHERE "referenceId" = $1`, [userId]);
    await pool.query(
      `UPDATE "user" SET "stripeCustomerId" = NULL, "emailVerified" = true
       WHERE id = $1::uuid`,
      [userId]
    );
    emailVerified = true;
    remoteSubscriptions = [];
    openSessions = [];
    subscriptionListImpl = async () => ({
      object: "list",
      data: remoteSubscriptions,
      has_more: false,
      url: "/v1/subscriptions"
    });
    checkoutListImpl = async () => ({
      object: "list",
      data: openSessions,
      has_more: false,
      url: "/v1/checkout/sessions"
    });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query(`DELETE FROM "user" WHERE id = $1::uuid`, [userId]);
    await pool.end();
  });

  async function checkout(options: {
    annual?: boolean;
    disableRedirect?: boolean;
    production?: boolean;
  } = {}): Promise<Response> {
    return fetch(`${baseUrl}/${options.production ? "checkout-production" : "checkout"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: config.appUrl
      },
      body: JSON.stringify({
        plan: "pro",
        annual: options.annual ?? false,
        disableRedirect: options.disableRedirect ?? false,
        successUrl: `${config.appUrl}/account?billing=success`,
        cancelUrl: `${config.appUrl}/account`,
        returnUrl: `${config.appUrl}/account`
      })
    });
  }

  it("creates one exact monthly Checkout and reuses it on a concurrent retry", async () => {
    const responses = await Promise.all([
      checkout({ disableRedirect: true }),
      checkout({ disableRedirect: true })
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{
      reused: boolean;
      redirect: boolean;
      url: string;
    }>;
    expect(bodies.map((body) => body.reused).sort()).toEqual([false, true]);
    expect(bodies.every((body) => body.redirect === false)).toBe(true);
    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate.mock.calls[0]?.[0]).toMatchObject({
      customer: customerId,
      line_items: [{ price: catalog.monthlyPriceId, quantity: 1 }],
      metadata: {
        draftrelay_checkout: stripeBillingInternals.CHECKOUT_METADATA_MARKER,
        referenceId: userId,
        billingInterval: "month"
      }
    });
    expect(checkoutCreate.mock.calls[0]?.[1]?.idempotencyKey)
      .toMatch(/^draftrelay-checkout-[0-9a-f-]{36}$/);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM subscription
       WHERE "referenceId" = $1 AND status = 'incomplete'`,
      [userId]
    )).rows[0]?.count).toBe("1");
  });

  it("starts a fresh yearly Checkout after the previous session expires", async () => {
    expect((await checkout()).status).toBe(200);
    const firstIdempotencyKey = checkoutCreate.mock.calls[0]?.[1]?.idempotencyKey;
    openSessions = [];
    expect((await checkout({ annual: true })).status).toBe(200);
    expect(checkoutCreate).toHaveBeenCalledTimes(2);
    expect(checkoutCreate.mock.calls[1]?.[0]).toMatchObject({
      line_items: [{ price: catalog.yearlyPriceId, quantity: 1 }],
      metadata: { billingInterval: "year" }
    });
    expect(checkoutCreate.mock.calls[1]?.[1]?.idempotencyKey).not.toBe(firstIdempotencyKey);
    expect((await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM subscription
       WHERE "referenceId" = $1 GROUP BY status ORDER BY status`,
      [userId]
    )).rows).toEqual([
      { status: "canceled", count: "1" },
      { status: "incomplete", count: "1" }
    ]);
  });

  it("reuses an unexpired monthly Checkout when a retry asks for yearly", async () => {
    const first = await checkout();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { url: string };
    const retry = await checkout({ annual: true });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      url: firstBody.url,
      redirect: true,
      reused: true
    });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM subscription
       WHERE "referenceId" = $1 AND status = 'incomplete'`,
      [userId]
    )).rows[0]?.count).toBe("1");
  });

  it("expires a stale-Price Checkout before creating an exact replacement", async () => {
    await pool.query(
      `UPDATE "user" SET "stripeCustomerId" = $2 WHERE id = $1::uuid`,
      [userId, customerId]
    );
    const stale = openCheckout("cs_stale_price", userId, "month", {
      customerId,
      priceId: "price_monthly_stale"
    });
    openSessions = [stale];

    const response = await checkout();
    expect(response.status).toBe(200);
    const body = await response.json() as { url: string; reused: boolean };
    expect(body.reused).toBe(false);
    expect(body.url).not.toBe(stale.url);
    expect(checkoutRetrieve).toHaveBeenCalledWith(stale.id, {
      expand: ["line_items.data.price"]
    });
    expect(checkoutExpire).toHaveBeenCalledWith(stale.id);
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate.mock.calls[0]?.[0]).toMatchObject({
      line_items: [{ price: catalog.monthlyPriceId, quantity: 1 }]
    });
  });

  it("fails closed on malformed authoritative line items without creating a duplicate", async () => {
    await pool.query(
      `UPDATE "user" SET "stripeCustomerId" = $2 WHERE id = $1::uuid`,
      [userId, customerId]
    );
    const malformed = openCheckout("cs_malformed", userId, "month", {
      customerId,
      malformedLineItems: true
    });
    openSessions = [malformed];

    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "billing_checkout_validation_failed" }
    });
    expect(checkoutRetrieve).toHaveBeenCalledTimes(1);
    expect(checkoutExpire).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("blocks a duplicate when a recoverable remote subscription is on a later page", async () => {
    subscriptionListImpl = async (params) => params.starting_after
      ? {
          object: "list",
          data: [remoteSubscription("sub_existing", "past_due")],
          has_more: false,
          url: "/v1/subscriptions"
        }
      : {
          object: "list",
          data: Array.from({ length: 100 }, (_, index) =>
            remoteSubscription(`sub_terminal_${index}`, "canceled")
          ),
          has_more: true,
          url: "/v1/subscriptions"
        };
    const response = await checkout();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "subscription_already_exists" }
    });
    expect(subscriptionsList).toHaveBeenCalledTimes(2);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("reuses a matching open Checkout from a later page", async () => {
    const matching = openCheckout("cs_later_page", userId, "month", { customerId });
    openSessions = [matching];
    checkoutListImpl = async (params) => params.starting_after
      ? {
          object: "list",
          data: [matching],
          has_more: false,
          url: "/v1/checkout/sessions"
        }
      : {
          object: "list",
          data: Array.from({ length: 100 }, (_, index) =>
            openCheckout(`cs_other_${index}`, randomUUID(), "month", { marker: false })
          ),
          has_more: true,
          url: "/v1/checkout/sessions"
        };
    const response = await checkout();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: matching.url,
      redirect: true,
      reused: true
    });
    expect(checkoutList).toHaveBeenCalledTimes(2);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("fails closed when Stripe inventory exceeds the bounded pagination window", async () => {
    let page = 0;
    subscriptionListImpl = async () => {
      page += 1;
      return {
        object: "list",
        data: [remoteSubscription(`sub_terminal_page_${page}`, "canceled")],
        has_more: true,
        url: "/v1/subscriptions"
      };
    };
    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "billing_inventory_incomplete" }
    });
    expect(subscriptionsList).toHaveBeenCalledTimes(10);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("fails closed when Stripe claims another page without a usable cursor", async () => {
    subscriptionListImpl = async () => ({
      object: "list",
      data: [],
      has_more: true,
      url: "/v1/subscriptions"
    });
    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "billing_inventory_incomplete" }
    });
    expect(subscriptionsList).toHaveBeenCalledTimes(1);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("requires verified email in production before any Stripe mutation", async () => {
    emailVerified = false;
    const response = await checkout({ production: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "email_verification_required" }
    });
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it("serializes checkout against account deletion and blocks later checkout", async () => {
    let releaseInventory!: () => void;
    let inventoryStarted!: () => void;
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const started = new Promise<void>((resolve) => {
      inventoryStarted = resolve;
    });
    subscriptionListImpl = async () => {
      inventoryStarted();
      await inventoryGate;
      return {
        object: "list",
        data: [],
        has_more: false,
        url: "/v1/subscriptions"
      };
    };

    const checkoutRequest = checkout();
    await started;
    const deletion = cloudAuthInternals.beginAccountDeletion(pool, userId);
    const deletionState = await Promise.race([
      deletion.then(() => "finished"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 25))
    ]);
    expect(deletionState).toBe("waiting");
    releaseInventory();
    expect((await checkoutRequest).status).toBe(200);
    await deletion;
    expect((await pool.query(
      `SELECT 1 FROM account_deletion_guard WHERE user_id = $1::uuid`,
      [userId]
    )).rowCount).toBe(1);
    const blocked = await checkout();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "account_deletion_in_progress" }
    });
  });
});
