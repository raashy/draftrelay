import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import { authClient } from "./auth-client";
import {
  billingState,
  checkoutIntent,
  mayResumeCheckout,
  mayStartCheckout,
  type BillingSubscription
} from "./billing-state";
import { startSubscriptionCheckout } from "./billing-api";
import { safeReturnTo } from "./navigation";

interface TurnstileApi {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: string;
    theme: "light";
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

let turnstileLoader: Promise<TurnstileApi> | undefined;
const SKIP_CONDITIONAL_PASSKEY_ONCE = "draftrelay.auth.skip-conditional-passkey-once";

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile
      ? resolve(window.turnstile)
      : reject(new Error("Signup verification did not load"));
    script.onerror = () => reject(new Error("Signup verification did not load"));
    document.head.append(script);
  });
  return turnstileLoader;
}

function TurnstileWidget({ siteKey, onToken }: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let widgetId: string | undefined;
    void loadTurnstile().then((api) => {
      if (disposed || !container.current) return;
      widgetId = api.render(container.current, {
        sitekey: siteKey,
        action: "signup",
        theme: "light",
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null)
      });
    }).catch(() => onToken(null));
    return () => {
      disposed = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, onToken]);
  return <div className="turnstile-slot" ref={container} aria-label="Signup verification" />;
}

const ReviewInbox = lazy(() => import("../client/App"));

interface ClientError {
  message?: string;
  code?: string;
  status?: number;
}

interface UsageSummary {
  plan: "free" | "pro";
  monthlySaves: { used: number; limit: number };
  dailySaves: { used: number; limit: number };
  storedItems: { used: number; limit: number };
  storageBytes: { used: number; limit: number };
  activeOAuthClients: { used: number; limit: number };
}

interface OAuthConnection {
  consentId: string;
  clientId: string;
  name: string;
  uri: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

function errorMessage(error: ClientError | null | undefined): string {
  return error?.message ?? "The request could not be completed. Please try again.";
}

function passkeyErrorMessage(error: ClientError | null | undefined): string {
  if (
    error?.code === "SESSION_NOT_FRESH" ||
    error?.message?.toLowerCase().includes("session is not fresh")
  ) {
    return "For security, sign out and sign back in before changing passkeys.";
  }
  return errorMessage(error);
}

function productUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="DraftRelay home">
      <span className="brand-mark" aria-hidden="true">D/</span>
      <span><strong>DraftRelay</strong><small>review inbox</small></span>
    </a>
  );
}

function LoadingPage({ label = "Opening your review inbox" }: { label?: string }) {
  return <main className="loading-page"><span>{label}…</span></main>;
}

function AuthAside() {
  return (
    <aside className="auth-aside" aria-label="What DraftRelay does">
      <p className="kicker">The useful part, on one page</p>
      <h2>Your agent writes.<br /><em>You decide what leaves.</em></h2>
      <p>Keep finished replies, summaries, decisions, and command sets separate from terminal scrollback. Review the exact revision, then copy it for the destination.</p>
      <article className="auth-specimen">
        <span>SLACK UPDATE · READY TO REVIEW</span>
        <h3>Launch checklist is complete</h3>
        <p>All required checks passed. One manual DNS verification remains before production release.</p>
      </article>
    </aside>
  );
}

interface AuthLayoutProps { children: ReactNode }

function AuthLayout({ children }: AuthLayoutProps) {
  return <main className="auth-layout"><section className="auth-panel"><Brand />{children}</section><AuthAside /></main>;
}

function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const returnTo = safeReturnTo(
    query.get("returnTo"),
    mode === "signup"
      ? query.get("plan") === "pro" ? "/app?welcome=1&plan=pro" : "/app?welcome=1"
      : "/app"
  );
  const wantsPro = isSignupPlan(query.get("plan"));
  const signInHref = wantsPro
    ? `/login?returnTo=${encodeURIComponent("/account?checkout=monthly")}`
    : "/login";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publicConfig, setPublicConfig] = useState<{
    turnstile?: { siteKey: string };
  } | null | undefined>(undefined);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);
  const isSignup = mode === "signup";

  useEffect(() => {
    if (!isSignup) return;
    const controller = new AbortController();
    void fetch("/api/public-config", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Public configuration is unavailable");
        return response.json() as Promise<{ turnstile?: { siteKey: string } }>;
      })
      .then(setPublicConfig)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setPublicConfig(null);
      });
    return () => controller.abort();
  }, [isSignup]);

  useEffect(() => {
    document.title = isSignup ? "Create your DraftRelay account" : "Sign in to DraftRelay";
  }, [isSignup]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = isSignup
        ? await authClient.signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
            callbackURL: productUrl(returnTo),
            ...(captchaToken
              ? { fetchOptions: { headers: { "x-captcha-response": captchaToken } } }
              : {})
          })
        : await authClient.signIn.email({ email: email.trim(), password, rememberMe: true, callbackURL: productUrl(returnTo) });
      if (result.error) {
        setError(errorMessage(result.error));
        return;
      }
      if (isSignup && !result.data?.token) {
        setNotice("Check your inbox to verify your email. The link will bring you back to finish setup.");
        return;
      }
      window.location.assign(returnTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      if (isSignup && publicConfig?.turnstile) {
        setCaptchaToken(null);
        setCaptchaEpoch((value) => value + 1);
      }
      setBusy(false);
    }
  }

  async function signInWithPasskey(): Promise<void> {
    setPasskeyBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.passkey({
        fetchOptions: { onSuccess: () => window.location.assign(returnTo) }
      });
      if (result.error) setError(errorMessage(result.error));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Passkey sign-in was canceled.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  useEffect(() => {
    if (isSignup || !("PublicKeyCredential" in window)) return;
    if (window.sessionStorage.getItem(SKIP_CONDITIONAL_PASSKEY_ONCE) === "1") {
      window.sessionStorage.removeItem(SKIP_CONDITIONAL_PASSKEY_ONCE);
      return;
    }
    const credential = PublicKeyCredential as typeof PublicKeyCredential & {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    };
    void credential.isConditionalMediationAvailable?.().then((available) => {
      if (!available) return;
      return authClient.signIn.passkey({ autoFill: true, fetchOptions: { onSuccess: () => window.location.assign(returnTo) } });
    }).catch(() => undefined);
  }, [isSignup, returnTo]);

  return (
    <AuthLayout>
      <div className="auth-card">
        <p className="kicker">{isSignup ? "Your private review inbox" : "Welcome back"}</p>
        <h1>{isSignup ? "Keep the answer." : "Open your inbox."}</h1>
        <p>{isSignup
          ? wantsPro
            ? "Create your account, connect an agent, then continue to the $1 monthly checkout. You can choose $10 yearly during setup."
            : "Start free. Add one MCP connection, then let your agent hand back only the result you need."
          : "Review what your agents finished and copy the right version."}</p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {isSignup && <label className="auth-field"><span>Name</span><input name="name" autoComplete="name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>}
          <label className="auth-field"><span>Email</span><input name="email" type="email" autoComplete="username webauthn" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="auth-field"><span>Password</span><input name="password" type="password" autoComplete={isSignup ? "new-password" : "current-password"} required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />{isSignup && <small>At least 12 characters. A password manager is recommended.</small>}</label>
          {isSignup && publicConfig?.turnstile && <TurnstileWidget key={captchaEpoch} siteKey={publicConfig.turnstile.siteKey} onToken={setCaptchaToken} />}
          <button className="button button--signal auth-submit" type="submit" disabled={busy || (isSignup && publicConfig === undefined) || Boolean(publicConfig?.turnstile && !captchaToken)}>{busy ? "Working…" : isSignup ? wantsPro ? "Create account and continue" : "Create free account" : "Sign in"}</button>
        </form>
        {!isSignup && <><div className="auth-divider">or</div><button className="button button--line passkey-button" type="button" onClick={() => void signInWithPasskey()} disabled={passkeyBusy}>{passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}</button></>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        {notice && <p className="auth-success" role="status">{notice}</p>}
        <div className="auth-meta">
          <span>{isSignup ? "Already have an account?" : "New to DraftRelay?"} <a href={isSignup ? signInHref : "/signup"}>{isSignup ? "Sign in" : "Start free"}</a></span>
          {!isSignup && <a href="/reset-password">Forgot password?</a>}
        </div>
      </div>
    </AuthLayout>
  );
}

function ResetPasswordPage() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = query.get("token");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = "Recover your DraftRelay account"; }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (token) {
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) setError(errorMessage(result.error));
        else setMessage("Password changed. You can now sign in with the new password.");
      } else {
        const result = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: productUrl("/reset-password") });
        if (result.error) setError(errorMessage(result.error));
        else setMessage("If that address has an account, a recovery link is on its way.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recovery could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="auth-card">
        <p className="kicker">Account recovery</p>
        <h1>{token ? "Choose a new password." : "Find your account."}</h1>
        <p>{token ? "This will revoke other sessions after the password changes." : "We will send a short-lived recovery link if the address is registered."}</p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {token
            ? <label className="auth-field"><span>New password</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            : <label className="auth-field"><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
          <button className="button button--signal auth-submit" type="submit" disabled={busy}>{busy ? "Working…" : token ? "Change password" : "Send recovery link"}</button>
        </form>
        {error && <p className="auth-error" role="alert">{error}</p>}
        {message && <p className="auth-success" role="status">{message} <a href="/login">Return to sign in</a>.</p>}
        <div className="auth-meta"><a href="/login">Back to sign in</a></div>
      </div>
    </AuthLayout>
  );
}

function isSignupPlan(value: string | null): boolean {
  return value === "pro";
}

interface SetupDialogProps {
  onClose: () => void;
  onChooseAnnual?: () => void;
}

type SetupClient = "claude" | "codex" | "generic";

const setupClients: ReadonlyArray<{ id: SetupClient; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "generic", label: "Other MCP client" }
];

function SetupDialog({ onClose, onChooseAnnual }: SetupDialogProps) {
  const [client, setClient] = useState<SetupClient>("claude");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const mcpUrl = `${window.location.origin}/mcp`;
  const setup = client === "claude"
    ? {
        value: `claude mcp add --transport http --scope user draftrelay ${mcpUrl}`,
        copyLabel: "Copy command",
        firstStep: "Paste the shown command in your terminal."
      }
    : client === "codex"
      ? {
          value: `codex mcp add draftrelay --url ${mcpUrl}\ncodex mcp login draftrelay`,
          copyLabel: "Copy commands",
          firstStep: "Paste the shown commands in your terminal."
        }
      : {
          value: mcpUrl,
          copyLabel: "Copy endpoint",
          firstStep: "Add this endpoint as a remote Streamable HTTP MCP server in your client."
        };

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  async function copyCommand(): Promise<void> {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(setup.value);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    copyTimerRef.current = window.setTimeout(() => setCopyStatus("idle"), 2_000);
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []).filter((element) => !element.hasAttribute("hidden"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % setupClients.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + setupClients.length) % setupClients.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = setupClients.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = setupClients[nextIndex];
    if (!next) return;
    setClient(next.id);
    dialogRef.current?.querySelector<HTMLButtonElement>(`#setup-tab-${next.id}`)?.focus();
  }

  return (
    <div className="setup-backdrop" role="presentation">
      <section ref={dialogRef} className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title" aria-describedby="setup-description" onKeyDown={handleDialogKeyDown}>
        <header><div><p className="kicker">One command, then OAuth</p><h2 id="setup-title">Connect your first agent.</h2></div><button ref={closeRef} type="button" aria-label="Close setup" onClick={onClose}>×</button></header>
        <div className="setup-dialog__body">
          <p id="setup-description">Choose a tested client, or copy the standards-based endpoint for any client that supports remote Streamable HTTP MCP with OAuth. It contains no token or secret.</p>
          <div className="client-switcher" role="tablist" aria-label="MCP client">
            {setupClients.map((candidate, index) => (
              <button
                id={`setup-tab-${candidate.id}`}
                key={candidate.id}
                role="tab"
                type="button"
                aria-controls="setup-panel"
                aria-selected={client === candidate.id}
                tabIndex={client === candidate.id ? 0 : -1}
                onClick={() => { setClient(candidate.id); setCopyStatus("idle"); }}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >{candidate.label}</button>
            ))}
          </div>
          <div id="setup-panel" className="setup-panel" role="tabpanel" aria-labelledby={`setup-tab-${client}`}>
            <div className="setup-command"><code>{setup.value}</code><button type="button" onClick={() => void copyCommand()}>{copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : setup.copyLabel}</button></div>
            <span className="visually-hidden" role="status" aria-live="polite">{copyStatus === "copied" ? "Copied to clipboard" : copyStatus === "error" ? "Could not copy to clipboard" : ""}</span>
            <ol className="setup-steps"><li>{setup.firstStep}</li><li>Approve the DraftRelay connection in the browser.</li><li>Ask: “Save the final Slack update to DraftRelay.”</li></ol>
          </div>
        </div>
        <footer>
          <button className="button button--ink" type="button" onClick={onClose}>{onChooseAnnual ? "Continue to $1 monthly" : "Go to my inbox"}</button>
          {onChooseAnnual && <button className="button button--line" type="button" onClick={onChooseAnnual}>Choose $10 yearly instead</button>}
        </footer>
      </section>
    </div>
  );
}

function DashboardPage() {
  const session = authClient.useSession();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [showSetup, setShowSetup] = useState(query.get("welcome") === "1" || window.localStorage.getItem("draftrelay.setup.dismissed") !== "1");
  const wantsPro = isSignupPlan(query.get("plan"));

  useEffect(() => { document.title = "Review inbox — DraftRelay"; }, []);
  useEffect(() => {
    if (!session.isPending && !session.data) {
      window.location.replace(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [session.data, session.isPending]);
  useEffect(() => {
    if (!session.data || showSetup || !wantsPro) return;
    window.location.replace("/account?checkout=monthly");
  }, [session.data, showSetup, wantsPro]);

  function finishSetup(checkout?: "monthly" | "yearly"): void {
    window.localStorage.setItem("draftrelay.setup.dismissed", "1");
    setShowSetup(false);
    if (checkout) {
      window.location.assign(`/account?checkout=${checkout}`);
      return;
    }
    window.history.replaceState(null, "", "/app");
  }

  if (session.isPending || !session.data) return <LoadingPage />;
  return (
    <>
      <Suspense fallback={<LoadingPage />}>
        <ReviewInbox deployment="cloud" productName="DraftRelay" onOpenAccount={() => window.location.assign("/account")} />
      </Suspense>
      {showSetup && <SetupDialog
        onClose={() => finishSetup(wantsPro ? "monthly" : undefined)}
        {...(wantsPro ? { onChooseAnnual: () => finishSetup("yearly") } : {})}
      />}
    </>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function UsageMeter({ label, used, limit, format = String }: { label: string; used: number; limit: number; format?: (value: number) => string }) {
  return <div className="usage-meter"><div><span>{label}</span><span>{format(used)} / {format(limit)}</span></div><progress value={used} max={Math.max(limit, 1)} aria-label={`${label}: ${format(used)} of ${format(limit)}`} /></div>;
}

function AccountPage() {
  const session = authClient.useSession();
  const passkeys = authClient.useListPasskeys();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [subscriptionLoad, setSubscriptionLoad] = useState<"loading" | "loaded" | "error">("loading");
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");

  useEffect(() => { document.title = "Account — DraftRelay"; }, []);
  useEffect(() => {
    if (!signingOut && !session.isPending && !session.data) {
      window.location.replace("/login?returnTo=%2Faccount");
    }
  }, [session.data, session.isPending, signingOut]);
  useEffect(() => {
    if (!session.data) return;
    void fetch("/api/usage", { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<UsageSummary> : Promise.reject(new Error("Usage is unavailable")))
      .then(setUsage)
      .catch(() => undefined);
    void loadSubscriptions();
    void fetch("/api/oauth/connections", { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{ connections: OAuthConnection[] }> : Promise.reject(new Error("Connections are unavailable")))
      .then((value) => setConnections(value.connections))
      .catch(() => undefined);
  }, [session.data]);

  const billing = billingState(subscriptions);
  const requestedCheckout = checkoutIntent(window.location.search);
  useEffect(() => {
    if (!session.data || subscriptionLoad !== "loaded" || !requestedCheckout) return;
    window.history.replaceState(null, "", "/account?billing=starting");
    if (
      mayStartCheckout(subscriptionLoad, billing) ||
      mayResumeCheckout(subscriptionLoad, billing)
    ) {
      void upgrade(requestedCheckout === "yearly");
      return;
    }
    if (billing.kind === "recovery") {
      setMessage("Your existing subscription needs attention. Open billing to update payment details; no second subscription was created.");
    }
  }, [billing.kind, requestedCheckout, session.data, subscriptionLoad]);

  if (session.isPending || !session.data) return <LoadingPage label="Opening account settings" />;

  async function addPasskey(): Promise<void> {
    setBusy("passkey"); setError(null); setMessage(null);
    try {
      const result = await authClient.passkey.addPasskey({ name: "Primary passkey" });
      if (result.error) setError(passkeyErrorMessage(result.error));
      else { setMessage("Passkey added."); await passkeys.refetch(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Passkey setup failed."); }
    finally { setBusy(null); }
  }

  async function removePasskey(passkey: { id: string; name?: string }): Promise<void> {
    const label = passkey.name?.trim() || "Passkey";
    if (!window.confirm(`Remove ${label}? You will no longer be able to sign in with it.`)) return;
    setBusy(`passkey:${passkey.id}`); setError(null); setMessage(null);
    try {
      const result = await authClient.passkey.deletePasskey({ id: passkey.id });
      if (result.error) setError(passkeyErrorMessage(result.error));
      else { setMessage(`${label} removed.`); await passkeys.refetch(); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The passkey could not be removed.");
    } finally { setBusy(null); }
  }

  async function upgrade(annual: boolean): Promise<void> {
    if (
      !mayStartCheckout(subscriptionLoad, billing) &&
      !mayResumeCheckout(subscriptionLoad, billing)
    ) {
      setError("Billing status must load before starting a checkout.");
      return;
    }
    setBusy(annual ? "annual" : "monthly"); setError(null);
    try {
      await startSubscriptionCheckout({
        annual,
        successUrl: productUrl("/account?billing=success"),
        cancelUrl: productUrl("/account"),
        returnUrl: productUrl("/account")
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Checkout could not be opened."); }
    finally { setBusy(null); }
  }

  async function loadSubscriptions(): Promise<void> {
    setSubscriptionLoad("loading");
    setError(null);
    try {
      const response = await fetch("/api/billing/subscriptions", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("Billing status is unavailable");
      const result = await response.json() as { subscriptions: BillingSubscription[] };
      setSubscriptions(result.subscriptions);
      setSubscriptionLoad("loaded");
    } catch {
      setSubscriptions([]);
      setSubscriptionLoad("error");
      setError("Billing status is unavailable. DraftRelay will not start a checkout until it can verify that you do not already have a subscription.");
    }
  }

  async function openBilling(): Promise<void> {
    setBusy("portal"); setError(null);
    try {
      const result = await authClient.subscription.billingPortal({ returnUrl: productUrl("/account") });
      if (result.error) setError(errorMessage(result.error));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Billing could not be opened.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut(): Promise<void> {
    setSigningOut(true);
    setError(null);
    window.sessionStorage.setItem(SKIP_CONDITIONAL_PASSKEY_ONCE, "1");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(errorMessage(result.error));
      window.location.replace("/");
    } catch (caught) {
      window.sessionStorage.removeItem(SKIP_CONDITIONAL_PASSKEY_ONCE);
      setSigningOut(false);
      setError(caught instanceof Error ? caught.message : "Sign out failed.");
    }
  }

  async function revokeConnection(connection: OAuthConnection): Promise<void> {
    setBusy(`revoke:${connection.consentId}`); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/oauth/connections/${encodeURIComponent(connection.consentId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-App-Request": "1" },
        body: "{}"
      });
      if (!response.ok) throw new Error("The connection could not be revoked.");
      setConnections((current) => current.filter((candidate) => candidate.consentId !== connection.consentId));
      setMessage(`${connection.name} was disconnected. Its refresh tokens are revoked immediately.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The connection could not be revoked.");
    } finally { setBusy(null); }
  }

  async function deleteAccount(): Promise<void> {
    if (deleteConfirm !== "DELETE") return;
    setBusy("delete"); setError(null); setMessage(null);
    try {
      const result = await authClient.deleteUser({
        password: deletePassword,
        callbackURL: productUrl("/")
      });
      if (result.error) {
        setError(errorMessage(result.error));
        setBusy(null);
        return;
      }
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account deletion failed.");
      setBusy(null);
    }
  }

  return (
    <div className="account-shell">
      <a className="skip-link" href="#main">Skip to account settings</a>
      <header className="account-header"><Brand /><nav><a href="/app">Review inbox</a><button type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button></nav></header>
      <main id="main" className="account-main" tabIndex={-1}>
        <header><div><p className="kicker">Account and connections</p><h1>{session.data.user.name}</h1></div><p>{session.data.user.email}</p></header>
        {(error || message) && <p className={error ? "auth-error" : "auth-success"} role={error ? "alert" : "status"}>{error ?? message}</p>}
        <div className="account-grid">
          <section className="account-section">
            <h2>Plan</h2><p>DraftRelay keeps the free tier useful and the paid tier deliberately inexpensive.</p>
            {subscriptionLoad === "loading" && <p role="status">Checking your Stripe subscription…</p>}
            {subscriptionLoad === "error" && <div className="plan-row"><div><strong>Billing status unavailable</strong><small>No checkout will start while subscription state is unknown.</small></div><button className="button button--line" type="button" onClick={() => void loadSubscriptions()}>Retry</button></div>}
            {subscriptionLoad === "loaded" && <>
              <div className="plan-row"><div><strong>{billing.kind === "active" ? "Pro" : billing.kind === "recovery" ? billing.subscription.status === "incomplete" ? "Checkout unfinished" : "Billing needs attention" : "Free"}</strong><small>{billing.kind === "free" ? "No card required" : `${billing.subscription.status} · ${billing.subscription.billingInterval ?? "subscription"}`}</small></div>{billing.kind !== "free" ? billing.kind === "recovery" && billing.subscription.status === "incomplete" ? <button className="button button--line" type="button" disabled={busy !== null} onClick={() => void upgrade(billing.subscription.billingInterval === "year")}>Resume checkout</button> : <button className="button button--line" type="button" disabled={busy === "portal"} onClick={() => void openBilling()}>{billing.kind === "recovery" ? "Fix billing" : "Manage billing"}</button> : null}</div>
              {billing.kind === "recovery" && <p role="status">{billing.subscription.status === "incomplete" ? "Resume the existing Checkout. DraftRelay reuses any unexpired session and will not open a second payable Checkout." : "Update payment details or resolve the existing subscription in Stripe. DraftRelay will not start another checkout while this subscription is recoverable."}</p>}
              {billing.kind === "free" && <div className="account-actions"><button className="primary" type="button" disabled={busy !== null} onClick={() => void upgrade(false)}>$1 monthly</button><button type="button" disabled={busy !== null} onClick={() => void upgrade(true)}>$10 yearly</button></div>}
            </>}
          </section>
          <section className="account-section">
            <h2>Sign-in security</h2><p>Passkeys use your device’s screen lock and are resistant to phishing.</p>
            <div className="plan-row"><div><strong>{passkeys.data?.length ?? 0} passkey{passkeys.data?.length === 1 ? "" : "s"}</strong><small>Password recovery stays available through your verified email.</small></div></div>
            <div className="account-actions"><button className="primary" type="button" disabled={busy === "passkey"} onClick={() => void addPasskey()}>{busy === "passkey" ? "Waiting…" : "Add a passkey"}</button></div>
            {passkeys.data && passkeys.data.length > 0 && <div className="connection-list passkey-list">{passkeys.data.map((passkey) => <div key={passkey.id}><div><strong>{passkey.name?.trim() || "Passkey"}</strong><small>{passkey.backedUp ? "Synced credential" : "Device credential"} · added {new Date(passkey.createdAt).toLocaleDateString()}</small></div><button type="button" disabled={busy === `passkey:${passkey.id}`} onClick={() => void removePasskey(passkey)}>{busy === `passkey:${passkey.id}` ? "Removing…" : "Remove"}</button></div>)}</div>}
          </section>
          <section className="account-section account-section--wide">
            <h2>Usage</h2><p>Limits reset on calendar boundaries. An over-limit write is rejected before storing content.</p>
            {usage ? <><UsageMeter label="Saves this month" {...usage.monthlySaves} /><UsageMeter label="Saves today" {...usage.dailySaves} /><UsageMeter label="Stored artifacts" {...usage.storedItems} /><UsageMeter label="Storage" {...usage.storageBytes} format={formatBytes} /><UsageMeter label="MCP clients" {...usage.activeOAuthClients} /></> : <p>Usage details are loading…</p>}
          </section>
          <section className="account-section account-section--wide">
            <h2>Connect an agent</h2><p>The command includes only the server URL. OAuth approval happens in your browser and can be revoked later.</p>
            <div className="account-actions"><button className="primary" type="button" onClick={() => { window.localStorage.removeItem("draftrelay.setup.dismissed"); window.location.assign("/app?welcome=1"); }}>Show setup commands</button><a className="button button--line" href="/docs">Open documentation</a></div>
            <div className="connection-list">
              {connections.length === 0 ? <p>No MCP clients are connected yet.</p> : connections.map((connection) => <div key={connection.consentId}><div><strong>{connection.name}</strong><small>{connection.scopes.filter((scope) => scope.startsWith("outputs:")).join(" · ")} · connected {new Date(connection.createdAt).toLocaleDateString()}</small></div><button type="button" disabled={busy === `revoke:${connection.consentId}`} onClick={() => void revokeConnection(connection)}>{busy === `revoke:${connection.consentId}` ? "Revoking…" : "Revoke"}</button></div>)}
            </div>
          </section>
          <section className="account-section account-section--wide">
            <h2>Your data</h2><p>Download a complete JSON export of app-held account and workspace data; credential material, IP addresses, provider-only records, logs, and backups are excluded. Deleting the account permanently removes the personal workspace and revokes its sessions and OAuth tokens; an active Stripe subscription is canceled first.</p>
            <div className="account-actions"><a className="button button--line" href="/api/account/export">Download export</a></div>
            <div className="danger-zone">
              <label className="auth-field"><span>Current password</span><input type="password" autoComplete="current-password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} /></label>
              <label className="auth-field"><span>Type DELETE to confirm</span><input value={deleteConfirm} autoComplete="off" onChange={(event) => setDeleteConfirm(event.target.value)} /></label>
              <button type="button" className="danger" disabled={busy === "delete" || !deletePassword || deleteConfirm !== "DELETE"} onClick={() => void deleteAccount()}>{busy === "delete" ? "Deleting…" : "Delete account permanently"}</button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function ConsentPage() {
  const session = authClient.useSession();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<{ client_name?: string; client_uri?: string } | null>(null);
  const scopes = (query.get("scope") ?? "outputs:read outputs:write outputs:use").split(/\s+/).filter(Boolean);
  const clientId = query.get("client_id") ?? "MCP client";

  useEffect(() => { document.title = "Approve MCP connection — DraftRelay"; }, []);
  useEffect(() => {
    if (!session.isPending && !session.data) {
      const returnTo = window.location.pathname + window.location.search;
      window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [session.data, session.isPending]);
  useEffect(() => {
    if (!session.data || clientId === "MCP client") return;
    const controller = new AbortController();
    void fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, {
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("Client details are unavailable");
      return response.json() as Promise<{ client_name?: string; client_uri?: string }>;
    }).then(setClient).catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setClient(null);
    });
    return () => controller.abort();
  }, [clientId, session.data]);

  async function decide(accept: boolean): Promise<void> {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, scope: scopes.join(" "), oauth_query: window.location.search })
      });
      const body = await response.json() as { redirect_uri?: string; url?: string; message?: string };
      const redirect = body.redirect_uri ?? body.url;
      if (!response.ok || !redirect) throw new Error(body.message ?? "Authorization could not be completed.");
      window.location.assign(redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authorization could not be completed.");
      setBusy(false);
    }
  }

  if (session.isPending || !session.data) return <LoadingPage label="Checking your session" />;
  const clientName = client?.client_name?.trim() || "MCP client";
  return (
    <AuthLayout>
      <div className="auth-card">
        <p className="kicker">MCP authorization</p>
        <h1>Connect this client?</h1>
        <p><strong>{clientName}</strong> is requesting access to your DraftRelay inbox. <small>Client ID: <code>{clientId.length > 60 ? `${clientId.slice(0, 57)}…` : clientId}</code></small></p>
        <ul className="consent-scopes">{scopes.map((scope) => <li key={scope}>{scope === "outputs:read" ? "Read saved artifacts" : scope === "outputs:write" ? "Save and revise artifacts" : scope === "outputs:use" ? "Record when an artifact is used" : scope === "offline_access" ? "Stay connected until you revoke access" : scope}</li>)}</ul>
        <div className="account-actions"><button className="primary" type="button" disabled={busy} onClick={() => void decide(true)}>Approve connection</button><button type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button></div>
        <p>No password or API token is shared with the client. You can revoke the OAuth grant from account settings.</p>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
    </AuthLayout>
  );
}

export default function CloudApp() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  if (path === "/login") return <AuthPage mode="login" />;
  if (path === "/signup") return <AuthPage mode="signup" />;
  if (path === "/reset-password") return <ResetPasswordPage />;
  if (path === "/consent") return <ConsentPage />;
  if (path === "/account") return <AccountPage />;
  if (path === "/app") return <DashboardPage />;
  window.location.replace("/");
  return <LoadingPage label="Returning home" />;
}
