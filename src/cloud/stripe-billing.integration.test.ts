import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import express from "express";
import pino from "pino";
import { Pool } from "pg";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadCloudConfig } from "./config.js";
import {
  createStripeBillingService,
  type StripeApi,
  type StripeBillingService
} from "./stripe-billing.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

function price(
  id: string,
  interval: "month" | "year",
  lookupKey: string | null = null
): Stripe.Price {
  const amount = interval === "month" ? 100 : 1_000;
  return {
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: 1,
    currency: "usd",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: lookupKey,
    metadata: {},
    nickname: null,
    product: "prod_pro",
    recurring: {
      interval,
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed"
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: amount,
    unit_amount_decimal: null
  };
}

function subscription(
  id: string,
  customerId: string,
  userId: string,
  status: Stripe.Subscription.Status,
  subscriptionPrice: Stripe.Price
): Stripe.Subscription {
  return {
    id,
    object: "subscription",
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: true, liability: null },
    billing_cycle_anchor: 1_800_000_000,
    billing_cycle_anchor_config: null,
    billing_mode: { type: "flexible", flexible: { proration_discounts: "included" }, updated_at: 1_800_000_000 },
    billing_thresholds: null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: { comment: null, feedback: null, reason: null },
    collection_method: "charge_automatically",
    created: 1_700_000_000,
    currency: "usd",
    customer: customerId,
    customer_account: null,
    days_until_due: null,
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    ended_at: null,
    invoice_settings: {
      account_tax_ids: null,
      issuer: { type: "self" }
    },
    items: {
      object: "list",
      data: [{
        id: `si_${id}`,
        object: "subscription_item",
        billing_thresholds: null,
        created: 1_700_000_000,
        current_period_end: 1_800_000_000,
        current_period_start: 1_700_000_000,
        discounts: [],
        metadata: {},
        price: subscriptionPrice,
        quantity: 1,
        subscription: id,
        tax_rates: []
      }],
      has_more: false,
      url: `/v1/subscription_items?subscription=${id}`
    },
    latest_invoice: null,
    livemode: false,
    managed_payments: { enabled: false },
    metadata: { referenceId: userId, subscriptionId: randomUUID() },
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: "off"
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    start_date: 1_700_000_000,
    status,
    test_clock: null,
    transfer_data: null,
    trial_end: null,
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
    trial_start: null
  } as unknown as Stripe.Subscription;
}

function subscriptionEvent(
  id: string,
  value: Stripe.Subscription,
  type: "customer.subscription.created" | "customer.subscription.updated" = "customer.subscription.updated"
): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_700_000_000,
    data: { object: value },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type
  } as Stripe.Event;
}

function checkoutEvent(id: string, subscriptionId: string): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_700_000_001,
    data: {
      object: {
        id: `cs_${id}`,
        object: "checkout.session",
        subscription: subscriptionId
      } as Stripe.Checkout.Session
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed"
  } as Stripe.Event;
}

integration("owned Stripe billing webhook", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const userId = randomUUID();
  const customerId = `cus_integration_${userId}`;
  const eventIds = new Set<string>();
  const monthly = price("price_monthly", "month", "draftrelay_pro_monthly");
  const yearly = price("price_yearly", "year", "draftrelay_pro_yearly");
  const subscriptions = new Map<string, Stripe.Subscription>();
  const events = new Map<string, Stripe.Event>();
  let nextRetrieveError: unknown;
  let retrieveGate: Promise<void> | undefined;
  let service: StripeBillingService;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "stripeCustomerId")
       VALUES ($1, 'Billing Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
      [userId, `billing-${userId}@example.com`, customerId]
    );
    const client = {
      prices: {
        list: vi.fn(async (params: Stripe.PriceListParams) => ({
          object: "list" as const,
          data: [monthly, yearly].filter((candidate) =>
            params.lookup_keys?.includes(candidate.lookup_key ?? "")
          ),
          has_more: false,
          url: "/v1/prices"
        }))
      },
      products: {
        retrieve: vi.fn(async () => ({
          id: "prod_pro",
          object: "product" as const,
          active: true,
          attributes: [],
          created: 1,
          default_price: monthly.id,
          description: null,
          images: [],
          livemode: false,
          marketing_features: [],
          metadata: {},
          name: "DraftRelay Pro",
          package_dimensions: null,
          shippable: null,
          statement_descriptor: null,
          tax_code: null,
          type: "service" as const,
          unit_label: null,
          updated: 1,
          url: null
        }))
      },
      subscriptions: {
        list: vi.fn(async (params: Stripe.SubscriptionListParams) => ({
          object: "list" as const,
          data: Array.from(subscriptions.values()).filter((candidate) =>
            candidate.customer === params.customer
          ),
          has_more: false,
          url: "/v1/subscriptions"
        })),
        retrieve: vi.fn(async (id: string) => {
          if (nextRetrieveError) {
            const error = nextRetrieveError;
            nextRetrieveError = undefined;
            throw error;
          }
          if (retrieveGate) await retrieveGate;
          const value = subscriptions.get(id);
          if (!value) throw { code: "resource_missing", statusCode: 404 };
          return value;
        })
      },
      customers: {},
      webhooks: {
        constructEventAsync: vi.fn(async (payload: Buffer) => {
          const parsed = JSON.parse(payload.toString("utf8")) as { eventId?: unknown };
          if (typeof parsed.eventId !== "string") throw new Error("test_event_id_missing");
          const event = events.get(parsed.eventId);
          if (!event) throw new Error("test_event_not_registered");
          return event;
        })
      }
    } as unknown as StripeApi;
    service = (await createStripeBillingService(loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://localhost:3941",
      DATABASE_URL: databaseUrl!,
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_integration"
    }), pool, pino({ level: "silent" }), { client, startWorker: false }))!;
    const app = express();
    app.post("/webhook", express.raw({ type: "application/json" }), service.webhookHandler);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    service?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query(
      `DELETE FROM webhook_event WHERE provider_event_id = ANY($1::text[])`,
      [Array.from(eventIds)]
    );
    await pool.query(`DELETE FROM "user" WHERE id = $1::uuid`, [userId]);
    await pool.end();
  });

  async function deliver(event: Stripe.Event): Promise<Response> {
    eventIds.add(event.id);
    events.set(event.id, event);
    return fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "signed" },
      body: JSON.stringify({ eventId: event.id })
    });
  }

  async function waitForEventStatus(
    eventId: string,
    expected: string | string[]
  ): Promise<{ status: string; attempts: number; last_error: string | null }> {
    const statuses = new Set(Array.isArray(expected) ? expected : [expected]);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        `SELECT status, attempts, last_error FROM webhook_event
         WHERE provider = 'stripe' AND provider_event_id = $1`,
        [eventId]
      );
      const row = result.rows[0];
      if (row && statuses.has(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Stripe event ${eventId}`);
  }

  it("is idempotent and reconciles the authoritative current state", async () => {
    const eventId = `evt_order_${userId}`;
    const active = subscription("sub_current", customerId, userId, "active", monthly);
    subscriptions.set(active.id, active);
    const event = subscriptionEvent(
      eventId,
      subscription(active.id, customerId, userId, "past_due", monthly)
    );
    expect((await deliver(event)).status).toBe(200);
    await waitForEventStatus(eventId, "succeeded");
    const reconciled = await pool.query<{ status: string }>(
      `SELECT status FROM subscription WHERE "stripeSubscriptionId" = $1`,
      [active.id]
    );
    expect(reconciled.rows[0]?.status).toBe("active");
    expect((await deliver(event)).status).toBe(200);
    const idempotent = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_event WHERE provider_event_id = $1`,
      [eventId]
    );
    expect(idempotent.rows[0]).toEqual({ status: "succeeded", attempts: 1 });
  });

  it("dead-letters permanent catalog failures and supports an explicit replay", async () => {
    const eventId = `evt_wrong_price_${userId}`;
    const duplicatePrice = price("price_unconfigured_duplicate", "month");
    const wrong = subscription("sub_wrong_price", customerId, userId, "active", duplicatePrice);
    subscriptions.set(wrong.id, wrong);
    expect((await deliver(
      subscriptionEvent(eventId, wrong, "customer.subscription.created")
    )).status).toBe(200);
    await waitForEventStatus(eventId, "dead_letter");
    const wrongEvent = await pool.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM webhook_event WHERE provider_event_id = $1`,
      [eventId]
    );
    expect(wrongEvent.rows[0]).toEqual({
      status: "dead_letter",
      last_error: "stripe_price_not_configured"
    });
    expect((await pool.query(
      `SELECT 1 FROM subscription WHERE "stripeSubscriptionId" = $1`,
      [wrong.id]
    )).rowCount).toBe(0);

    subscriptions.set(wrong.id, subscription(wrong.id, customerId, userId, "active", monthly));
    await service.replay(eventId);
    expect((await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_event WHERE provider_event_id = $1`,
      [eventId]
    )).rows[0]).toEqual({ status: "succeeded", attempts: 1 });
  });

  it("retries transient provider failures without persisting provider details", async () => {
    const eventId = `evt_retry_${userId}`;
    const annual = subscription("sub_retry", customerId, userId, "active", yearly);
    subscriptions.set(annual.id, annual);
    nextRetrieveError = Object.assign(new Error("provider timeout detail"), { statusCode: 503 });
    expect((await deliver(checkoutEvent(eventId, annual.id))).status).toBe(200);
    expect(await waitForEventStatus(eventId, "failed")).toEqual({
      status: "failed",
      attempts: 1,
      last_error: "stripe_reconciliation_failed"
    });
    await pool.query(
      `UPDATE webhook_event SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE provider_event_id = $1`,
      [eventId]
    );
    await service.retryDue();
    const retried = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status, attempts, last_error FROM webhook_event WHERE provider_event_id = $1`,
      [eventId]
    );
    expect(retried.rows[0]).toEqual({ status: "succeeded", attempts: 2, last_error: null });
    expect((await pool.query<{ billingInterval: string }>(
      `SELECT "billingInterval" FROM subscription WHERE "stripeSubscriptionId" = $1`,
      [annual.id]
    )).rows[0]?.billingInterval).toBe("year");
  });

  it("processes more simultaneous webhooks than the database pool size without deadlock", async () => {
    const simultaneous = Array.from({ length: 12 }, (_, index) => {
      const value = subscription(
        `sub_concurrent_${index}_${userId}`,
        customerId,
        userId,
        "active",
        monthly
      );
      subscriptions.set(value.id, value);
      return subscriptionEvent(`evt_concurrent_${index}_${userId}`, value);
    });
    const responses = await Promise.all(simultaneous.map(deliver));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(simultaneous.map((event) => waitForEventStatus(event.id, "succeeded")));
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM subscription
       WHERE "stripeSubscriptionId" LIKE 'sub_concurrent_%' AND "referenceId" = $1`,
      [userId]
    )).rows[0]?.count).toBe(String(simultaneous.length));
  }, 10_000);

  it("periodically revokes a missed remote cancellation", async () => {
    const eventId = `evt_missed_cancel_${userId}`;
    const active = subscription("sub_missed_cancel", customerId, userId, "active", monthly);
    subscriptions.set(active.id, active);
    expect((await deliver(subscriptionEvent(eventId, active))).status).toBe(200);
    await waitForEventStatus(eventId, "succeeded");
    await pool.query(
      `UPDATE subscription SET "stripeSyncedAt" = CURRENT_TIMESTAMP - INTERVAL '25 hours'
       WHERE "stripeSubscriptionId" = $1`,
      [active.id]
    );
    subscriptions.set(active.id, subscription(active.id, customerId, userId, "canceled", monthly));
    await service.reconcileDue();
    expect((await pool.query<{ status: string; fresh: boolean }>(
      `SELECT status, "stripeSyncedAt" > CURRENT_TIMESTAMP - INTERVAL '1 minute' AS fresh
       FROM subscription WHERE "stripeSubscriptionId" = $1`,
      [active.id]
    )).rows[0]).toEqual({ status: "canceled", fresh: true });
  });

  it("acknowledges a durably queued event before authoritative retrieval finishes", async () => {
    const eventId = `evt_prompt_ack_${userId}`;
    const active = subscription("sub_prompt_ack", customerId, userId, "active", monthly);
    subscriptions.set(active.id, active);
    let releaseRetrieve!: () => void;
    retrieveGate = new Promise<void>((resolve) => {
      releaseRetrieve = resolve;
    });
    try {
      const outcome = await Promise.race([
        deliver(subscriptionEvent(eventId, active)),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250))
      ]);
      expect(outcome).not.toBe("timeout");
      if (outcome !== "timeout") {
        expect(outcome.status).toBe(200);
        expect(await outcome.json()).toEqual({ received: true });
      }
    } finally {
      releaseRetrieve();
      retrieveGate = undefined;
    }
    await waitForEventStatus(eventId, "succeeded");
  });

  it("recovers a completed Checkout whose webhook was lost when the account is opened", async () => {
    const localSubscriptionId = randomUUID();
    const remote = subscription(
      `sub_lost_webhook_${userId}`,
      customerId,
      userId,
      "active",
      yearly
    );
    remote.metadata.subscriptionId = localSubscriptionId;
    subscriptions.set(remote.id, remote);
    await pool.query(
      `INSERT INTO subscription (
         id, plan, "referenceId", "stripeCustomerId", status, seats, "billingInterval"
       ) VALUES ($1::uuid, 'pro', $2, $3, 'incomplete', 1, 'year')`,
      [localSubscriptionId, userId, customerId]
    );

    await service.reconcileUser(userId);

    expect((await pool.query<{
      id: string;
      stripeSubscriptionId: string;
      status: string;
      billingInterval: string;
    }>(
      `SELECT id, "stripeSubscriptionId", status, "billingInterval"
       FROM subscription WHERE id = $1::uuid`,
      [localSubscriptionId]
    )).rows[0]).toEqual({
      id: localSubscriptionId,
      stripeSubscriptionId: remote.id,
      status: "active",
      billingInterval: "year"
    });
  });

  it("blocks inserts during deletion and lets the user foreign key win an insert-delete race", async () => {
    const guardedUserId = randomUUID();
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Guarded Billing Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [guardedUserId, `billing-guard-${guardedUserId}@example.com`]
    );
    await pool.query(
      `INSERT INTO account_deletion_guard (user_id) VALUES ($1::uuid)`,
      [guardedUserId]
    );
    await expect(pool.query(
      `INSERT INTO subscription (id, plan, "referenceId", status, seats)
       VALUES ($1::uuid, 'pro', $2, 'active', 1)`,
      [randomUUID(), guardedUserId]
    )).rejects.toMatchObject({ code: "23514" });
    await pool.query(`DELETE FROM "user" WHERE id = $1::uuid`, [guardedUserId]);

    const racingUserId = randomUUID();
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Racing Billing Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [racingUserId, `billing-race-${racingUserId}@example.com`]
    );
    const deleting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      await deleting.query(`DELETE FROM "user" WHERE id = $1::uuid`, [racingUserId]);
      const inserting = pool.query(
        `INSERT INTO subscription (id, plan, "referenceId", status, seats)
         VALUES ($1::uuid, 'pro', $2, 'active', 1)`,
        [randomUUID(), racingUserId]
      ).then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await deleting.query("COMMIT");
      const insertion = await inserting;
      expect(insertion.ok).toBe(false);
      expect(insertion.error).toMatchObject({ code: "23503" });
    } finally {
      await deleting.query("ROLLBACK").catch(() => undefined);
      deleting.release();
    }

    expect((await pool.query(
      `SELECT 1 FROM subscription WHERE "referenceId" = $1`,
      [racingUserId]
    )).rowCount).toBe(0);
  });
});
