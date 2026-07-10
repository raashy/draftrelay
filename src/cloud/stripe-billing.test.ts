import type { Pool } from "pg";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { cloudAuthInternals } from "./auth.js";
import { loadCloudConfig } from "./config.js";
import {
  isStripeResourceMissing,
  stripeBillingInternals,
  type StripeApi,
  type StripeCatalog,
  validateStripeCatalog
} from "./stripe-billing.js";

function configuredPrice(
  lookupKey: string,
  options: { amount?: number; interval?: "month" | "year"; product?: string } = {}
): Stripe.Price {
  const interval = options.interval ?? "month";
  return {
    id: interval === "month" ? "price_monthly" : "price_yearly",
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
    product: options.product ?? "prod_pro",
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
    unit_amount: options.amount ?? (interval === "month" ? 100 : 1_000),
    unit_amount_decimal: null
  };
}

function testConfig() {
  return loadCloudConfig({
    NODE_ENV: "test",
    APP_URL: "http://localhost:3941",
    DATABASE_URL: "postgres://draftrelay:draftrelay@localhost:5432/draftrelay",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example"
  });
}

function catalogClient(prices: Stripe.Price[]): StripeApi {
  return {
    prices: {
      list: vi.fn(async (params: Stripe.PriceListParams) => ({
        object: "list" as const,
        data: prices.filter((price) => params.lookup_keys?.includes(price.lookup_key ?? "")),
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
        default_price: null,
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
    subscriptions: {} as StripeApi["subscriptions"],
    customers: {} as StripeApi["customers"],
    webhooks: {} as StripeApi["webhooks"]
  } as unknown as StripeApi;
}

const reuseCatalog: StripeCatalog = {
  monthlyPriceId: "price_monthly_current",
  yearlyPriceId: "price_yearly_current",
  productId: "prod_pro",
  livemode: false,
  validatedAt: Date.now()
};

function checkoutForReuse(options: {
  priceId?: string;
  malformedLineItems?: boolean;
} = {}): Stripe.Checkout.Session {
  const price = configuredPrice("draftrelay_pro_monthly");
  price.id = options.priceId ?? reuseCatalog.monthlyPriceId;
  return {
    id: "cs_reuse",
    object: "checkout.session",
    mode: "subscription",
    status: "open",
    customer: "cus_reuse",
    client_reference_id: "user_reuse",
    livemode: false,
    expires_at: 2_000,
    url: "https://checkout.stripe.test/cs_reuse",
    metadata: {
      draftrelay_checkout: stripeBillingInternals.CHECKOUT_METADATA_MARKER,
      userId: "user_reuse",
      referenceId: "user_reuse",
      billingInterval: "month"
    },
    ...(options.malformedLineItems
      ? {}
      : {
          line_items: {
            object: "list",
            data: [{ quantity: 1, price }],
            has_more: false,
            url: "/v1/checkout/sessions/cs_reuse/line_items"
          }
        })
  } as unknown as Stripe.Checkout.Session;
}

describe("Stripe Checkout reuse validation", () => {
  const expected = {
    userId: "user_reuse",
    customerId: "cus_reuse",
    catalog: reuseCatalog,
    now: 1_000
  };

  it("reuses only an exact current-catalog Checkout for the exact user", () => {
    expect(stripeBillingInternals.inspectCheckoutForReuse(
      checkoutForReuse(),
      expected
    ).kind).toBe("reuse");
  });

  it("requires a structurally valid stale Price Checkout to be expired", () => {
    expect(stripeBillingInternals.inspectCheckoutForReuse(
      checkoutForReuse({ priceId: "price_stale" }),
      expected
    ).kind).toBe("expire");
  });

  it("fails closed when authoritative line items are missing", () => {
    expect(stripeBillingInternals.inspectCheckoutForReuse(
      checkoutForReuse({ malformedLineItems: true }),
      expected
    ).kind).toBe("fail_closed");
  });
});

describe("Stripe billing catalog", () => {
  it("accepts only the exact active $1 monthly and $10 yearly test catalog", async () => {
    const catalog = await validateStripeCatalog(testConfig(), catalogClient([
      configuredPrice("draftrelay_pro_monthly"),
      configuredPrice("draftrelay_pro_yearly", { interval: "year" })
    ]));
    expect(catalog).toMatchObject({
      monthlyPriceId: "price_monthly",
      yearlyPriceId: "price_yearly",
      productId: "prod_pro",
      livemode: false
    });
  });

  it("rejects a mispriced lookup key", async () => {
    await expect(validateStripeCatalog(testConfig(), catalogClient([
      configuredPrice("draftrelay_pro_monthly", { amount: 200 }),
      configuredPrice("draftrelay_pro_yearly", { interval: "year" })
    ]))).rejects.toThrow("USD 100 recurring month Price");
  });

  it("rejects Prices attached to different Products", async () => {
    await expect(validateStripeCatalog(testConfig(), catalogClient([
      configuredPrice("draftrelay_pro_monthly"),
      configuredPrice("draftrelay_pro_yearly", { interval: "year", product: "prod_other" })
    ]))).rejects.toThrow("same Product");
  });
});

describe("Stripe deletion safety", () => {
  it("recognizes idempotent missing-resource responses", () => {
    expect(isStripeResourceMissing({ code: "resource_missing" })).toBe(true);
    expect(isStripeResourceMissing({ statusCode: 404 })).toBe(true);
    expect(isStripeResourceMissing({ statusCode: 503 })).toBe(false);
  });

  it("ignores missing Stripe resources and still deletes the customer", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ stripeSubscriptionId: "sub_missing" }] })
      .mockResolvedValueOnce({ rows: [{ stripeCustomerId: "cus_missing" }] });
    const cancel = vi.fn().mockRejectedValue({ code: "resource_missing" });
    const del = vi.fn().mockRejectedValue({ code: "resource_missing" });
    await expect(cloudAuthInternals.deleteStripeResources(
      { query } as unknown as Pool,
      { subscriptions: { cancel }, customers: { del } } as unknown as Stripe,
      "00000000-0000-4000-8000-000000000001"
    )).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("sub_missing");
    expect(del).toHaveBeenCalledWith("cus_missing");
  });

  it("propagates transient Stripe failures so account deletion stops", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ stripeSubscriptionId: "sub_retry" }] });
    const transient = Object.assign(new Error("temporary"), { statusCode: 503 });
    await expect(cloudAuthInternals.deleteStripeResources(
      { query } as unknown as Pool,
      {
        subscriptions: { cancel: vi.fn().mockRejectedValue(transient) },
        customers: { del: vi.fn() }
      } as unknown as Stripe,
      "00000000-0000-4000-8000-000000000001"
    )).rejects.toBe(transient);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("Stripe webhook failure codes", () => {
  it("never persists an arbitrary provider error message", () => {
    expect(stripeBillingInternals.safeFailureCode(new Error("customer card 4242 failed")))
      .toBe("stripe_reconciliation_failed");
    expect(stripeBillingInternals.safeFailureCode(new Error("stripe_customer_mismatch")))
      .toBe("stripe_customer_mismatch");
  });
});
