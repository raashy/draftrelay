import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";
import helmet from "helmet";
import pino, { type Logger } from "pino";
import pinoHttp from "pino-http";

import type { CloudAuth } from "./auth.js";
import type { CloudConfig } from "./config.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_REQUEST_PATHS = [
  "err.body",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "req.body.password",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.otp",
  "req.body.token",
  "req.body.code",
  "req.body.client_secret",
  "req.body.refresh_token",
  "res.headers.set-cookie"
];

export interface RequestLocals {
  requestId: string;
}

export type CloudSession = NonNullable<
  Awaited<ReturnType<CloudAuth["api"]["getSession"]>>
>;

export interface SessionLocals extends RequestLocals {
  auth: CloudSession;
}

export interface McpPrincipal {
  userId: string;
  scopes: string[];
  clientId?: string;
  expiresAt?: number;
}

export interface McpLocals extends RequestLocals {
  mcp: McpPrincipal;
}

export interface AccessTokenPayload {
  sub?: unknown;
  scope?: unknown;
  azp?: unknown;
  client_id?: unknown;
  exp?: unknown;
  [claim: string]: unknown;
}

export interface AccessTokenVerifier {
  verifyAccessToken: (
    token: string | undefined,
    options: {
      verifyOptions: { issuer: string; audience: string };
      scopes: string[];
    }
  ) => Promise<AccessTokenPayload>;
}

function requestIdFromHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) return undefined;
  return value;
}

export function requestIdMiddleware(): RequestHandler<
  Record<string, string>,
  unknown,
  unknown,
  Record<string, string>,
  RequestLocals
> {
  return (request, response, next) => {
    const requestId = requestIdFromHeader(request.headers["x-request-id"]) ?? randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    next();
  };
}

export function trustedClientIpMiddleware(): RequestHandler {
  return (request, _response, next) => {
    // This header is private to the application. Overwriting it prevents a
    // caller from selecting their own Better Auth rate-limit bucket. Express
    // only trusts forwarded hops listed in TRUSTED_PROXY_IPS.
    request.headers["x-draftrelay-client-ip"] = request.ip;
    next();
  };
}

export function createCloudLogger(config: CloudConfig): Logger {
  return pino({
    name: "draftrelay-cloud",
    level: config.logLevel,
    base: {
      service: "draftrelay-cloud",
      environment: config.environment
    },
    redact: {
      paths: SENSITIVE_REQUEST_PATHS,
      censor: "[REDACTED]"
    }
  });
}

function pathWithoutQuery(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export function requestLoggingMiddleware(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId(request, response) {
      const requestId = response.getHeader("X-Request-Id");
      if (typeof requestId === "string") return requestId;
      return requestIdFromHeader(request.headers["x-request-id"]) ?? randomUUID();
    },
    quietReqLogger: true,
    quietResLogger: true,
    wrapSerializers: false,
    serializers: {
      req(request) {
        return {
          id: request.id,
          method: request.method,
          path: pathWithoutQuery(request.url),
          remoteAddress: request.socket.remoteAddress,
          userAgent: request.headers["user-agent"]
        };
      },
      res(response) {
        return { statusCode: response.statusCode };
      },
      err: pino.stdSerializers.err
    },
    redact: {
      paths: SENSITIVE_REQUEST_PATHS,
      censor: "[REDACTED]"
    },
    autoLogging: {
      ignore(request) {
        const path = pathWithoutQuery(request.url);
        return path === "/health" || path === "/health/live" || path === "/health/ready" ||
          path === "/favicon.svg" || path === "/social-card.svg" || path?.startsWith("/assets/") === true;
      }
    }
  });
}

export function securityHeaders(config: CloudConfig): RequestHandler {
  const turnstileOrigin = "https://challenges.cloudflare.com";
  const middleware = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'", ...(config.turnstile ? [turnstileOrigin] : [])],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", ...(config.turnstile ? [turnstileOrigin] : [])],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: config.turnstile ? [turnstileOrigin] : ["'none'"],
        ...(config.environment === "production"
          ? { upgradeInsecureRequests: [] }
          : { upgradeInsecureRequests: null })
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts:
      config.environment === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    referrerPolicy: { policy: "no-referrer" }
  });

  return (request, response, next) => {
    middleware(request, response, (error?: unknown) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(self), publickey-credentials-create=(self), publickey-credentials-get=(self)"
      );
      next();
    });
  };
}

function errorBody(response: { locals: Partial<RequestLocals> }, code: string, message: string) {
  return {
    error: {
      code,
      message,
      ...(response.locals.requestId ? { requestId: response.locals.requestId } : {})
    }
  };
}

export function allowedHostMiddleware(config: CloudConfig): RequestHandler {
  const allowedHostnames = new Set(
    config.trustedOrigins.map((origin) => new URL(origin).hostname.toLowerCase())
  );

  return (request, response, next) => {
    const hostname = request.hostname.toLowerCase();
    if (!allowedHostnames.has(hostname)) {
      response
        .status(400)
        .json(errorBody(response, "invalid_host", "The request host is not allowed"));
      return;
    }
    next();
  };
}

export function exactOriginCsrf(config: CloudConfig): RequestHandler {
  return (request, response, next) => {
    if (!MUTATING_METHODS.has(request.method) || !request.headers.cookie) {
      next();
      return;
    }

    const origin = request.get("origin");
    const fetchSite = request.get("sec-fetch-site");
    const requestedWith = request.get("x-app-request");
    const contentType = request.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

    if (
      origin !== config.appUrl ||
      fetchSite === "cross-site" ||
      requestedWith !== "1" ||
      contentType !== "application/json"
    ) {
      response.setHeader("Cache-Control", "no-store");
      response
        .status(403)
        .json(errorBody(response, "csrf_rejected", "The request failed origin validation"));
      return;
    }

    next();
  };
}

export function requireSession(auth: CloudAuth): RequestHandler {
  return async (request, response, next) => {
    try {
      const { fromNodeHeaders } = await import("better-auth/node");
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers)
      });
      if (!session) {
        response.setHeader("Cache-Control", "no-store");
        response
          .status(401)
          .json(errorBody(response, "unauthorized", "Authentication is required"));
        return;
      }
      (response.locals as Partial<SessionLocals>).auth = session;
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  return match?.[1];
}

function payloadScopes(payload: AccessTokenPayload): string[] {
  if (typeof payload.scope === "string") {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(payload.scope)) {
    return payload.scope.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

export function createMcpAuthMiddleware(
  config: CloudConfig,
  verifier: AccessTokenVerifier,
  requiredScopes: string[]
): RequestHandler {
  const resourceMetadata = `${config.appUrl}/.well-known/oauth-protected-resource/mcp`;

  return async (request, response, next) => {
    const token = bearerToken(request.get("authorization"));
    const challenge = `Bearer resource_metadata="${resourceMetadata}"${
      requiredScopes.length > 0 ? `, scope="${requiredScopes.join(" ")}"` : ""
    }`;

    if (token === undefined) {
      response.setHeader("WWW-Authenticate", challenge);
      response
        .status(401)
        .json(errorBody(response, "invalid_token", "A valid bearer token is required"));
      return;
    }

    try {
      const payload = await verifier.verifyAccessToken(token, {
        verifyOptions: {
          issuer: config.authUrl,
          audience: config.mcpUrl
        },
        scopes: requiredScopes
      });

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("The access token is missing a subject");
      }

      const clientId =
        typeof payload.azp === "string"
          ? payload.azp
          : typeof payload.client_id === "string"
            ? payload.client_id
            : undefined;
      const expiresAt = typeof payload.exp === "number" ? payload.exp : undefined;
      (response.locals as Partial<McpLocals>).mcp = {
        userId: payload.sub,
        scopes: payloadScopes(payload),
        ...(clientId ? { clientId } : {}),
        ...(expiresAt ? { expiresAt } : {})
      };
      next();
    } catch (_error: unknown) {
      request.log?.warn(
        {
          code: "mcp_token_verification_failed",
          requestId: response.locals.requestId
        },
        "MCP access token verification failed"
      );
      response.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      response
        .status(401)
        .json(errorBody(response, "invalid_token", "The bearer token is invalid or expired"));
    }
  };
}

export const cloudSecurityInternals = {
  bearerToken,
  pathWithoutQuery,
  payloadScopes,
  requestIdFromHeader
};
