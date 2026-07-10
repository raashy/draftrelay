import { describe, expect, it } from "vitest";

import {
  billingState,
  checkoutIntent,
  mayResumeCheckout,
  mayStartCheckout
} from "./billing-state";

describe("billing state", () => {
  it("prioritizes an active subscription", () => {
    expect(billingState([
      { id: "recoverable", plan: "pro", status: "past_due" },
      { id: "active", plan: "pro", status: "active", billingInterval: "month" }
    ])).toMatchObject({ kind: "active", subscription: { id: "active" } });
  });

  it.each(["past_due", "unpaid", "paused", "incomplete"])(
    "routes %s through billing recovery instead of another checkout",
    (status) => {
      expect(billingState([{ id: "existing", plan: "pro", status }])).toEqual({
        kind: "recovery",
        subscription: { id: "existing", plan: "pro", status }
      });
    }
  );

  it("allows a new checkout only after terminal subscriptions", () => {
    expect(billingState([
      { id: "old", plan: "pro", status: "canceled" },
      { id: "expired", plan: "pro", status: "incomplete_expired" }
    ])).toEqual({ kind: "free" });
  });

  it("routes an active subscription on an unrecognized Price to billing recovery", () => {
    expect(billingState([
      { id: "sub_unknown", plan: "unrecognized", status: "active" }
    ])).toMatchObject({ kind: "recovery", subscription: { id: "sub_unknown" } });
  });

  it("allows only an incomplete Checkout to resume through the exclusive server path", () => {
    const incomplete = billingState([{ id: "sub_open", plan: "pro", status: "incomplete" }]);
    const pastDue = billingState([{ id: "sub_due", plan: "pro", status: "past_due" }]);
    expect(mayResumeCheckout("loaded", incomplete)).toBe(true);
    expect(mayResumeCheckout("loading", incomplete)).toBe(false);
    expect(mayResumeCheckout("loaded", pastDue)).toBe(false);
  });

  it("accepts only explicit monthly and yearly checkout intents", () => {
    expect(checkoutIntent("?checkout=monthly")).toBe("monthly");
    expect(checkoutIntent("?checkout=yearly")).toBe("yearly");
    expect(checkoutIntent("?checkout=pro")).toBeUndefined();
  });

  it("fails closed while subscription state is loading or unavailable", () => {
    const free = billingState([]);
    expect(mayStartCheckout("loading", free)).toBe(false);
    expect(mayStartCheckout("error", free)).toBe(false);
    expect(mayStartCheckout("loaded", free)).toBe(true);
    expect(mayStartCheckout("loaded", billingState([
      { id: "existing", plan: "pro", status: "past_due" }
    ]))).toBe(false);
  });
});
