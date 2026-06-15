/**
 * Transport-agnostic `/api/network/*` router. Both the production middleware
 * (Node `http`) and the dev server (`Bun.serve`) normalize their request into a
 * `NetworkRouteRequest`, call `handleNetworkRoute`, and render the returned
 * `NetworkRouteResult` with their own response API — so the inspector's HTTP
 * surface (auth rules, status codes, payload shapes) lives in exactly one place.
 */
import { timingSafeEqual } from "crypto";
import { getNetworkInspector } from "./controller";

/** Normalized request for one `/api/network/...` call. */
export interface NetworkRouteRequest {
  method: string;
  /** Path after the `/api/network` prefix, no leading slash (e.g. `start`, `requests/ID/body`). */
  sub: string;
  params: URLSearchParams;
  /** Host header — used to reject cross-origin mutating requests. */
  host?: string;
  origin?: string;
  contentType?: string;
  authorization?: string;
  /** Device selected via `?device=` (falls back for start/trust). */
  selectedDevice?: string | null;
  /** Parse the JSON request body (only called for mutating routes). */
  readJson: () => Promise<unknown>;
}

/** Normalized response, rendered by each transport's adapter. */
export type NetworkRouteResult =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "bytes"; status: number; contentType: string; body: Buffer }
  | { kind: "text"; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | {
      kind: "sse";
      /** Wire up the stream; return a teardown the adapter calls on disconnect. */
      subscribe: (emit: (chunk: string) => void) => () => void;
    };

export interface NetworkRouteContext {
  execToken: string;
  version: string;
}

/** Thrown by a transport's `readJson` when the request body exceeds its cap. */
export class PayloadTooLargeError extends Error {}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  // `application/json; charset=utf-8` etc. — only the media type matters.
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

const json = (status: number, body: unknown): NetworkRouteResult => ({ kind: "json", status, body });

/**
 * Handle a `/api/network/...` request. Mutating routes change system state
 * (proxy, CA trust) and are gated by the bearer token + same-origin; read-only
 * routes (status/requests/events/har) are same-origin like the other SSE feeds.
 */
export async function handleNetworkRoute(
  req: NetworkRouteRequest,
  ctx: NetworkRouteContext,
): Promise<NetworkRouteResult> {
  try {
    return await routeNetwork(req, ctx);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return json(413, { ok: false, error: "Payload Too Large" });
    }
    throw err;
  }
}

async function routeNetwork(
  req: NetworkRouteRequest,
  ctx: NetworkRouteContext,
): Promise<NetworkRouteResult> {
  const inspector = getNetworkInspector(ctx.version);
  const { sub, params } = req;

  // Returns a 4xx result when auth fails, or null when the caller may proceed.
  const requireAuth = (): NetworkRouteResult | null => {
    if (!isJsonContentType(req.contentType) && req.method !== "DELETE") {
      return json(415, { ok: false, error: "Unsupported Media Type" });
    }
    if (req.origin) {
      try {
        if (new URL(req.origin).host !== req.host) {
          return json(403, { ok: false, error: "Cross-origin request blocked" });
        }
      } catch {
        return json(403, { ok: false, error: "Invalid Origin" });
      }
    }
    const m = /^Bearer\s+(.+)$/i.exec(req.authorization ?? "");
    if (!m || !safeEqualString(m[1]!.trim(), ctx.execToken)) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    return null;
  };

  const readBody = async (): Promise<any> => {
    try {
      return (await req.readJson()) ?? {};
    } catch (e) {
      if (e instanceof PayloadTooLargeError) throw e; // → 413 at the top
      return {}; // malformed JSON is treated as an empty body, as before
    }
  };

  // POST /api/network/start — begin capture for the selected device.
  if (sub === "start" && req.method === "POST") {
    const denied = requireAuth(); if (denied) return denied;
    const body = await readBody();
    const decryptHosts = Array.isArray(body?.decryptHosts)
      ? body.decryptHosts.filter((h: unknown) => typeof h === "string")
      : null;
    const udid = (typeof body?.udid === "string" && body.udid) || req.selectedDevice || undefined;
    try {
      const status = await inspector.start({ udid: udid ?? undefined, decryptHosts });
      return json(200, { ok: true, status });
    } catch (err: any) {
      return json(500, { ok: false, error: err?.message ?? String(err) });
    }
  }

  // POST /api/network/stop — stop capture, restore system proxy.
  if (sub === "stop" && req.method === "POST") {
    const denied = requireAuth(); if (denied) return denied;
    await readBody();
    try {
      const status = await inspector.stop({ uninstall: params.get("uninstall") === "1" });
      return json(200, { ok: true, status });
    } catch (err: any) {
      return json(500, { ok: false, error: err?.message ?? String(err) });
    }
  }

  // POST /api/network/{trust,untrust} — install/reset CA on the selected device.
  if ((sub === "trust" || sub === "untrust") && req.method === "POST") {
    const denied = requireAuth(); if (denied) return denied;
    const body = await readBody();
    const udid = (typeof body?.udid === "string" && body.udid) || req.selectedDevice;
    if (!udid) return json(400, { ok: false, error: "No device selected" });
    const result = sub === "trust" ? inspector.trust(udid) : inspector.untrust(udid);
    return json(result.ok ? 200 : 500, { ok: result.ok, error: result.error, result });
  }

  // GET /api/network/status
  if (sub === "status" && req.method === "GET") {
    return json(200, inspector.status());
  }

  // GET /api/network/requests — metadata list.
  if (sub === "requests" && req.method === "GET") {
    return json(200, {
      exchanges: inspector.store.list({
        limit: Number(params.get("limit")) || 200,
        offset: Number(params.get("offset")) || 0,
        filter: params.get("filter") ?? undefined,
      }),
      total: inspector.store.size,
    });
  }

  // DELETE /api/network/requests — clear the buffer.
  if (sub === "requests" && req.method === "DELETE") {
    const denied = requireAuth(); if (denied) return denied;
    inspector.store.clear();
    return json(200, { ok: true });
  }

  // GET /api/network/requests/:id  and  /requests/:id/body
  if (sub.startsWith("requests/") && req.method === "GET") {
    const rest = sub.slice("requests/".length);
    const [id, tail] = rest.split("/");
    if (tail === "body") {
      const kind = params.get("kind") === "request" ? "request" : "response";
      const body = inspector.store.body(id!, kind);
      if (!body || !body.data) {
        return { kind: "text", status: 404, body: "No body" };
      }
      const ex = inspector.store.get(id!);
      const ct = ex?.responseHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value;
      return {
        kind: "bytes",
        status: 200,
        contentType: kind === "response" && ct ? ct : "application/octet-stream",
        body: body.data,
      };
    }
    const exchange = inspector.store.get(id!);
    if (!exchange) return json(404, { ok: false, error: "Not found" });
    // Inline small bodies as base64 so the detail view renders in one fetch.
    const inlineBody = (b: typeof exchange.requestBody) =>
      b && b.data ? { size: b.size, truncated: b.truncated, base64: b.data.toString("base64") } : null;
    return json(200, {
      ...exchange,
      requestBody: inlineBody(exchange.requestBody),
      responseBody: inlineBody(exchange.responseBody),
    });
  }

  // GET /api/network/events — SSE stream of new exchanges.
  if (sub === "events" && req.method === "GET") {
    return {
      kind: "sse",
      subscribe: (emit) => {
        emit(":\n\n");
        const onExchange = (summary: unknown) => emit(`data: ${JSON.stringify(summary)}\n\n`);
        inspector.store.on("exchange", onExchange);
        const heartbeat = setInterval(() => emit(":\n\n"), 15000);
        return () => {
          inspector.store.off("exchange", onExchange);
          clearInterval(heartbeat);
        };
      },
    };
  }

  // GET /api/network/har — download the capture as a HAR 1.2 file.
  if (sub === "har" && req.method === "GET") {
    return {
      kind: "text",
      status: 200,
      body: JSON.stringify(inspector.store.toHar(), null, 2),
      contentType: "application/json",
      headers: { "Content-Disposition": 'attachment; filename="serve-sim.har"' },
    };
  }

  return json(404, { ok: false, error: "Unknown network route" });
}
