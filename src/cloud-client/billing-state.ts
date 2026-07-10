export interface BillingSubscription {
  id: string;
  plan: string;
  status: string;
  billingInterval?: string;
  periodEnd?: string | null;
}

export type BillingState =
  | { kind: "active"; subscription: BillingSubscription }
  | { kind: "recovery"; subscription: BillingSubscription }
  | { kind: "free" };

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const RECOVERY_STATUSES = new Set(["past_due", "unpaid", "paused", "incomplete"]);

export function billingState(subscriptions: BillingSubscription[]): BillingState {
  const active = subscriptions.find((subscription) =>
    subscription.plan === "pro" && ACTIVE_STATUSES.has(subscription.status)
  );
  if (active) return { kind: "active", subscription: active };
  const recovery = subscriptions.find((subscription) =>
    RECOVERY_STATUSES.has(subscription.status) || ACTIVE_STATUSES.has(subscription.status)
  );
  if (recovery) return { kind: "recovery", subscription: recovery };
  return { kind: "free" };
}

export function checkoutIntent(search: string): "monthly" | "yearly" | undefined {
  const value = new URLSearchParams(search).get("checkout");
  return value === "monthly" || value === "yearly" ? value : undefined;
}

export function mayStartCheckout(
  loadState: "loading" | "loaded" | "error",
  state: BillingState
): boolean {
  return loadState === "loaded" && state.kind === "free";
}

export function mayResumeCheckout(
  loadState: "loading" | "loaded" | "error",
  state: BillingState
): boolean {
  return loadState === "loaded" && state.kind === "recovery" &&
    state.subscription.status === "incomplete";
}

export const billingStateInternals = { ACTIVE_STATUSES, RECOVERY_STATUSES };
