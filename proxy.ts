/**
 * Edge proxy (Next 16's successor to middleware): password gate on all routes +
 * hardened Content-Security-Policy + security headers.
 *
 * - Every request that isn't the login screen or an auth endpoint requires a
 *   valid session cookie; unauthenticated requests are redirected (pages) or
 *   rejected with 401 (API).
 * - A strict CSP is applied to every response, plus HSTS, nosniff, frame-deny,
 *   referrer, and permissions headers.
 *
 * TRADEOFF CALLOUT (rule 9) — script-src uses 'self' 'unsafe-inline' rather than
 * a per-request nonce with 'strict-dynamic'. The nonce approach is stronger, but
 * Next 16's automatic nonce injection does not stamp the framework's bootstrap
 * scripts in this version, so a nonce + 'strict-dynamic' policy blocks hydration
 * entirely (verified in a browser). Every OTHER directive stays strict:
 * default-src / connect-src / form-action are 'self' (blocking off-origin script
 * loads and data exfiltration), object-src and frame-ancestors are 'none', and
 * base-uri is 'self'. This app renders no user-controlled HTML and uses no
 * dangerouslySetInnerHTML — all catalogue text is fetched server-side and
 * rendered as escaped React text — so the residual inline-script XSS surface is
 * minimal. Restore a nonce + 'strict-dynamic' policy once Next's nonce
 * propagation works with the active builder.
 *
 * Runs on the edge runtime, so it only uses jose (via lib/auth) and Web APIs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Paths that must be reachable without a session.
const PUBLIC_PATHS = new Set<string>(["/login"]);
const PUBLIC_API_PREFIXES = ["/api/login", "/api/logout"];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

function buildCsp(): string {
  const isDev = process.env.NODE_ENV !== "production";
  // Next's dev tooling additionally needs 'unsafe-eval'; production does not.
  // Cover art is not fetched from Discogs in this build, so img-src stays
  // 'self' data:.
  const scriptSrc = isDev
    ? `'self' 'unsafe-inline' 'unsafe-eval'`
    : `'self' 'unsafe-inline'`;

  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    // All data (Discogs, Anthropic) is fetched server-side; the browser only
    // talks to this origin.
    `connect-src 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`,
  ];
  return directives.join("; ");
}

function applySecurityHeaders(response: NextResponse, csp: string): void {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const csp = buildCsp();
  const authed = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  // Gate everything that isn't explicitly public.
  if (!authed && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      applySecurityHeaders(res, csp);
      return res;
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const res = NextResponse.redirect(loginUrl);
    applySecurityHeaders(res, csp);
    return res;
  }

  // Already authenticated users hitting the login page go to the catalogue.
  if (authed && pathname === "/login") {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";
    const res = NextResponse.redirect(homeUrl);
    applySecurityHeaders(res, csp);
    return res;
  }

  const response = NextResponse.next();
  applySecurityHeaders(response, csp);
  return response;
}

export const config = {
  // Run on all routes except Next's static assets, the favicon, PWA icons, and
  // the manifest — those are served without the gate so the login screen and
  // installed-app shell can load.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg).*)",
  ],
};
