/**
 * Client-side fetch helpers for the vibe-shelf endpoints. Thin wrappers that
 * return typed payloads and normalise error handling.
 */

import type { MetaResponse, SearchResponse, SearchResult } from "@/lib/types";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const message = await extractError(res);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

async function extractError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    // ignore
  }
  return "Request failed. Please try again.";
}

export interface SearchParams {
  query: string;
  owners: string[];
  genres: string[];
  styles: string[];
  moods: string[];
}

export async function fetchMeta(): Promise<MetaResponse> {
  const res = await fetch("/api/meta", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return (await res.json()) as MetaResponse;
}

export function search(params: SearchParams): Promise<SearchResponse> {
  return postJson<SearchResponse>("/api/search", params);
}

export function surpriseMe(
  filters: Omit<SearchParams, "query">,
): Promise<{ result: SearchResult | null }> {
  return postJson("/api/random", filters);
}

export function moreLikeThis(
  id: string,
  owner: string,
): Promise<{ seed: SearchResult["record"]; results: SearchResult[] }> {
  return postJson("/api/similar", { id, owner });
}

export async function login(password: string): Promise<{ ok: true; role: string }> {
  return postJson("/api/login", { password });
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}
