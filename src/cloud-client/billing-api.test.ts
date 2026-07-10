import { describe, expect, it, vi } from "vitest";

import { startSubscriptionCheckout } from "./billing-api";

const request = {
  annual: true,
  successUrl: "https://app.example/account?billing=success",
  cancelUrl: "https://app.example/account",
  returnUrl: "https://app.example/account"
};

describe("owned checkout UI client", () => {
  it("posts the exact annual intent and follows an owned redirect response", async () => {
    const fetcher = vi.fn(async () => Response.json({
      url: "https://checkout.stripe.com/c/pay_test",
      redirect: true,
      reused: false
    }));
    const navigate = vi.fn();
    await expect(startSubscriptionCheckout(request, {
      fetcher: fetcher as typeof fetch,
      navigate
    })).resolves.toEqual({
      url: "https://checkout.stripe.com/c/pay_test",
      redirect: true,
      reused: false
    });
    expect(fetcher).toHaveBeenCalledWith("/api/auth/subscription/upgrade", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-App-Request": "1"
      },
      body: JSON.stringify({ plan: "pro", ...request })
    });
    expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay_test");
  });

  it("does not navigate when the caller requested a non-redirecting response", async () => {
    const navigate = vi.fn();
    const result = await startSubscriptionCheckout(
      { ...request, annual: false },
      {
        fetcher: vi.fn(async () => Response.json({
          url: "https://checkout.stripe.com/c/monthly",
          redirect: false,
          reused: true
        })) as typeof fetch,
        navigate
      }
    );
    expect(result).toMatchObject({ redirect: false, reused: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fails safely on provider errors or unsafe redirect payloads", async () => {
    await expect(startSubscriptionCheckout(request, {
      fetcher: vi.fn(async () => Response.json({
        error: { code: "billing_state_unavailable" }
      }, { status: 503 })) as typeof fetch
    })).rejects.toThrow("Checkout could not be opened.");
    await expect(startSubscriptionCheckout(request, {
      fetcher: vi.fn(async () => Response.json({
        url: "javascript:alert(1)",
        redirect: true
      })) as typeof fetch,
      navigate: vi.fn()
    })).rejects.toThrow("unsafe destination");
  });
});
