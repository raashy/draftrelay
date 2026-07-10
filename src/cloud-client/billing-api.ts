export interface CheckoutRequest {
  annual: boolean;
  successUrl: string;
  cancelUrl: string;
  returnUrl: string;
}

interface CheckoutResponse {
  url: string;
  redirect: boolean;
  reused: boolean;
}

function checkoutUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Checkout did not return a destination.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Checkout returned an unsafe destination.");
  }
  return parsed.toString();
}

export async function startSubscriptionCheckout(
  input: CheckoutRequest,
  options: {
    fetcher?: typeof fetch;
    navigate?: (url: string) => void;
  } = {}
): Promise<CheckoutResponse> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher("/api/auth/subscription/upgrade", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-App-Request": "1"
    },
    body: JSON.stringify({
      plan: "pro",
      annual: input.annual,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      returnUrl: input.returnUrl
    })
  });
  const payload = await response.json().catch(() => null) as {
    url?: unknown;
    redirect?: unknown;
    reused?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    const message = typeof payload?.error?.message === "string"
      ? payload.error.message
      : "Checkout could not be opened.";
    throw new Error(message);
  }
  const result: CheckoutResponse = {
    url: checkoutUrl(payload?.url),
    redirect: payload?.redirect === true,
    reused: payload?.reused === true
  };
  if (result.redirect) {
    (options.navigate ?? ((url) => window.location.assign(url)))(result.url);
  }
  return result;
}

export const billingApiInternals = { checkoutUrl };
