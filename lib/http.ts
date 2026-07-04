/**
 * Small HTTP helpers shared by the server-side data and search layers.
 *
 * Everything here runs server-side only. These helpers never surface upstream
 * error bodies to the client (rule 8) — callers translate failures into generic
 * messages. They also never log credentials (rule 5).
 */

/** Thrown for a non-2xx upstream response. Carries status for backoff logic. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch a URL over HTTPS and parse the body as JSON. Only https:// is allowed
 * (rule 6); an http:// URL throws before any request is made.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<{ data: T; headers: Headers }> {
  if (!url.startsWith("https://")) {
    throw new Error("Refusing to fetch a non-HTTPS URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // If the caller passed their own signal, abort our controller when it fires.
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
      // Data is fetched fresh server-side and cached in-process; don't let the
      // platform layer add its own caching semantics.
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    // Read (and discard) the body so the connection can be reused, but never
    // surface it upward.
    await response.text().catch(() => undefined);
    throw new HttpError(
      response.status,
      `Upstream responded with HTTP ${response.status}`,
      retryAfter,
    );
  }

  const data = (await response.json()) as T;
  return { data, headers: response.headers };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Await a number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
