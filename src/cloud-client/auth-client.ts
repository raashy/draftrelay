import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [passkeyClient(), oauthProviderClient(), stripeClient({ subscription: true })]
});
