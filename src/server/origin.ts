import type { RequestHandler } from "express";

const LOCAL_MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

function exactOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Native MCP clients generally omit Origin. Browser-originated requests must
 * name one of the exact configured origins to prevent DNS-rebinding attacks. */
export function suppliedOriginGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map(exactOrigin).filter((value): value is string => value !== undefined));
  return (request, response, next) => {
    const supplied = request.get("origin");
    if (supplied === undefined) {
      next();
      return;
    }
    const normalized = exactOrigin(supplied);
    if (normalized === undefined || !allowed.has(normalized)) {
      response.setHeader("Cache-Control", "no-store");
      response.status(403).json({
        error: { code: "invalid_origin", message: "The request origin is not allowed" }
      });
      return;
    }
    next();
  };
}

/**
 * Local HTTP writes accept either the browser UI's exact Origin or an explicit
 * native-client request. Origin-less requests are allowed only when they carry
 * the same non-simple header used by the UI and no browser Fetch Metadata. A
 * cross-site form cannot set that header, while CLI/smoke callers can do so
 * deliberately. This is an OS-account boundary, not authentication.
 */
export function localMutationGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(
    allowedOrigins.map(exactOrigin).filter((value): value is string => value !== undefined)
  );
  return (request, response, next) => {
    if (!LOCAL_MUTATING_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get("origin");
    const fetchSite = request.get("sec-fetch-site");
    const appRequest = request.get("x-app-request");
    const normalizedOrigin = origin === undefined ? undefined : exactOrigin(origin);
    const nativeRequest = origin === undefined && fetchSite === undefined;
    if (
      appRequest !== "1" ||
      fetchSite === "cross-site" ||
      (origin !== undefined && (normalizedOrigin === undefined || !allowed.has(normalizedOrigin))) ||
      (origin === undefined && !nativeRequest)
    ) {
      response.setHeader("Cache-Control", "no-store");
      response.status(403).json({
        error: {
          code: "local_csrf_rejected",
          message: "The local write request failed origin validation"
        }
      });
      return;
    }
    next();
  };
}

export const originInternals = { exactOrigin, LOCAL_MUTATING_METHODS };
