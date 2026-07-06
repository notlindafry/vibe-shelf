/**
 * Small server-side helpers for validating request input (rule 4) and reading
 * the session role inside route handlers.
 */

import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken, type Role } from "@/lib/auth";

/** Coerce untrusted JSON into a bounded array of trimmed strings. */
export function parseStringArray(value: unknown, maxItems = 50, maxLen = 100): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().slice(0, maxLen);
    if (trimmed) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Read and verify the session role from the request cookie. */
export async function getRole(request: NextRequest): Promise<Role | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = await verifySessionToken(token);
  return claims?.role ?? null;
}

/** True for a stringified numeric Discogs release id (rule 4). */
export function isReleaseId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,15}$/.test(value);
}

/**
 * Same-origin check for state-changing requests — CSRF defense-in-depth alongside
 * the SameSite=Lax session cookie (which already withholds itself from cross-site
 * POSTs). Compares the Origin (or Referer) host to the request Host. A write with
 * neither header is treated as cross-site and rejected.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}
