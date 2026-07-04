/**
 * Authentication: password gate + signed-JWT sessions.
 *
 * Two roles exist:
 *   - "owner": full access, unlocked with APP_PASSWORD.
 *   - "guest": read-only, unlocked with the optional APP_GUEST_PASSWORD.
 *
 * The app is read-only regardless of role, so the practical difference today is
 * small; the role is carried in the session so authorization is enforced
 * server-side (rule 2) and future write actions can deny-by-default for guests.
 *
 * Sessions are stateless JWTs (HS256) signed with SESSION_SECRET. `exp` is
 * validated server-side on every request via jwtVerify. Cookies are HttpOnly,
 * Secure, SameSite=Lax.
 *
 * This module is edge-runtime compatible (jose only, no Node crypto APIs) so it
 * can be imported from middleware.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export type Role = "owner" | "guest";

export const SESSION_COOKIE = "vibe_shelf_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionClaims {
  role: Role;
}

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    // Fail closed: without a strong secret we cannot sign or verify sessions,
    // so no one gets in. The generic error keeps details out of the client.
    throw new Error("SESSION_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

/** Returns true if a password gate is configured at all. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD && process.env.SESSION_SECRET);
}

/**
 * Constant-time string comparison. Avoids leaking password length/contents via
 * timing. Works on the edge runtime (no Node Buffer / timingSafeEqual).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Compare against the longer length so the loop count doesn't reveal which
  // input was shorter; fold the length difference into the result.
  const length = Math.max(aBytes.length, bBytes.length);
  let mismatch = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Check a submitted password against the configured passwords and return the
 * matching role, or null if none match. Always evaluates both comparisons to
 * avoid early-return timing differences between roles.
 */
export function checkPassword(submitted: string): Role | null {
  const ownerPassword = process.env.APP_PASSWORD ?? "";
  const guestPassword = process.env.APP_GUEST_PASSWORD ?? "";

  const ownerMatch = ownerPassword.length > 0 && constantTimeEqual(submitted, ownerPassword);
  const guestMatch = guestPassword.length > 0 && constantTimeEqual(submitted, guestPassword);

  if (ownerMatch) return "owner";
  if (guestMatch) return "guest";
  return null;
}

/** Create a signed session token for a role. */
export async function createSessionToken(role: Role): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role } satisfies SessionClaims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .setSubject("vibe-shelf")
    .sign(getSessionSecret());
}

/**
 * Verify a session token. Returns the claims on success, or null if the token
 * is missing, malformed, tampered, or expired (exp is validated by jwtVerify).
 */
export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify<JWTPayload & SessionClaims>(token, getSessionSecret(), {
      subject: "vibe-shelf",
    });
    if (payload.role === "owner" || payload.role === "guest") {
      return { role: payload.role };
    }
    return null;
  } catch {
    return null;
  }
}

/** Cookie attributes for setting the session. */
export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Cookie attributes for clearing the session on logout. */
export function clearSessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}
