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
