import { NextResponse, type NextRequest } from "next/server";
import { getRole } from "@/lib/request";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { getCollection } from "@/lib/discogs";
import { findDuplicates, type DuplicateAlbum } from "@/lib/duplicates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/duplicates — a one-off scan for albums both partners own (same album,
 * any pressing). Owner only. Returns a styled HTML report by default (open it in
 * the browser); add ?format=json for the raw data.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "duplicates", limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const role = await getRole(request);
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { records, partial } = await getCollection();
    const duplicates = findDuplicates(records);

    if (request.nextUrl.searchParams.get("format") === "json") {
      const report = duplicates.map((d) => {
        const copies = d.copies.map((c) => `${c.owner}${c.year ? ` (${c.year})` : ""}`).join(" · ");
        return `${d.artist} — ${d.title}  [${copies}]`;
      });
      return NextResponse.json({ count: duplicates.length, partial, report, duplicates });
    }

    return new NextResponse(renderHtml(duplicates, partial), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("[duplicates] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not scan for duplicates." }, { status: 502 });
  }
}

// --- HTML report -----------------------------------------------------------

/** Escape untrusted (Discogs-derived) text before putting it in HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0e1311; color: #e6ebe7;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; color: #f3f6f4; }
.sub { color: #9aa39d; margin: 0 0 24px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.album { background: #161c18; border: 1px solid #26302a; border-radius: 12px; padding: 13px 16px; }
.hd { font-weight: 600; }
.artist { color: #f3f6f4; }
.title { color: #c7cfc9; }
.copies { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.copies li { color: #9aa39d; font-size: 13.5px; }
.owner { color: #8fbf9f; }
a { color: #8fbf9f; text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { color: #9aa39d; }
`;

function renderCopy(copy: DuplicateAlbum["copies"][number]): string {
  const bits = [`<span class="owner">${esc(copy.owner)}</span>`];
  if (copy.year) bits.push(String(copy.year));
  if (copy.format) bits.push(esc(copy.format));
  const link = copy.discogsUrl
    ? ` &nbsp;<a href="${esc(copy.discogsUrl)}" target="_blank" rel="noopener noreferrer">Discogs ↗</a>`
    : "";
  return `<li>${bits.join(" · ")}${link}</li>`;
}

function renderHtml(duplicates: DuplicateAlbum[], partial: boolean): string {
  const partialNote = partial ? " (some records couldn’t be loaded)" : "";
  const sub =
    duplicates.length === 0
      ? `<p class="sub empty">No shared albums — your shelves don’t overlap${partialNote}.</p>`
      : `<p class="sub">${duplicates.length} album${duplicates.length === 1 ? "" : "s"} on both shelves${partialNote}.</p>`;

  const items = duplicates
    .map(
      (d) =>
        `<li class="album"><div class="hd"><span class="artist">${esc(d.artist)}</span> — <span class="title">${esc(
          d.title,
        )}</span></div><ul class="copies">${d.copies.map(renderCopy).join("")}</ul></li>`,
    )
    .join("");

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Duplicate albums · vibe-shelf</title><style>${STYLES}</style></head>` +
    `<body><main><h1>Duplicate albums</h1>${sub}<ol class="list">${items}</ol></main></body></html>`
  );
}
