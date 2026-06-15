/**
 * In-memory capture store for the network inspector.
 *
 * Holds a rolling buffer of {@link NetworkExchange} records (metadata always
 * retained; bodies retained under a global byte budget and evicted oldest-first
 * once it is exceeded, so a long capture can't OOM the dev server). Emits an
 * "exchange" event on every completed exchange for SSE subscribers, and
 * serializes the buffer to HAR 1.2 for export.
 */
import { EventEmitter } from "events";

export interface NetworkHeader {
  name: string;
  value: string;
}

/** Captured request/response body, retained inline until evicted by budget. */
export interface NetworkBody {
  /** Raw bytes; null once evicted to reclaim the global body budget. */
  data: Buffer | null;
  /** Original byte length, even after the inline copy is truncated/evicted. */
  size: number;
  /** True when `data` was capped below `size` at capture time. */
  truncated: boolean;
}

export interface NetworkExchange {
  id: string;
  /** Epoch milliseconds when the request was first seen. */
  startedAt: number;
  durationMs: number;
  method: string;
  url: string;
  host: string;
  scheme: "http" | "https";
  status: number | null;
  statusText?: string;
  httpVersion?: string;
  requestHeaders: NetworkHeader[];
  responseHeaders: NetworkHeader[];
  requestBody?: NetworkBody | null;
  responseBody?: NetworkBody | null;
  mimeType?: string;
  bytesSent: number;
  bytesReceived: number;
  error?: string | null;
  /** TLS tunnel we couldn't decrypt (pinned / client-cert / ATS). */
  tlsTunnelOnly?: boolean;
}

/** Metadata-only view (no body bytes) for list endpoints. */
export type NetworkExchangeSummary = Omit<
  NetworkExchange,
  "requestBody" | "responseBody"
> & {
  requestBodySize: number;
  responseBodySize: number;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
};

export interface NetworkStoreOptions {
  /** Max number of exchange records retained. Oldest evicted first. */
  cap?: number;
  /** Global ceiling on retained body bytes before oldest bodies are dropped. */
  bodyBudgetBytes?: number;
  /** serve-sim version, embedded in HAR creator. */
  version?: string;
}

const DEFAULT_CAP = 1000;
const DEFAULT_BODY_BUDGET = 64 * 1024 * 1024; // 64 MB

export class NetworkStore extends EventEmitter {
  private readonly cap: number;
  private readonly bodyBudget: number;
  private readonly version: string;
  private readonly exchanges: NetworkExchange[] = [];
  private retainedBytes = 0;

  constructor(opts: NetworkStoreOptions = {}) {
    super();
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.bodyBudget = opts.bodyBudgetBytes ?? DEFAULT_BODY_BUDGET;
    this.version = opts.version ?? "0.0.0";
    // Many SSE clients may attach; lift the default 10-listener warning cap.
    this.setMaxListeners(0);
  }

  /** Append a completed exchange, evicting to honor cap + body budget. */
  add(exchange: NetworkExchange): void {
    this.exchanges.push(exchange);
    this.retainedBytes += bodyBytes(exchange.requestBody) + bodyBytes(exchange.responseBody);

    while (this.exchanges.length > this.cap) {
      const dropped = this.exchanges.shift()!;
      this.retainedBytes -= this.releaseBodies(dropped);
    }
    // Evict oldest bodies (keep metadata) until under the global budget.
    for (let i = 0; i < this.exchanges.length && this.retainedBytes > this.bodyBudget; i++) {
      this.retainedBytes -= this.releaseBodies(this.exchanges[i]!);
    }

    this.emit("exchange", this.summarize(exchange));
  }

  /** Newest-first metadata list, optionally filtered by host/url substring. */
  list(opts: { limit?: number; offset?: number; filter?: string } = {}): NetworkExchangeSummary[] {
    const { limit = 200, offset = 0, filter } = opts;
    const needle = filter?.toLowerCase();
    const matched = this.exchanges.filter(
      (e) => !needle || e.host.toLowerCase().includes(needle) || e.url.toLowerCase().includes(needle),
    );
    return matched
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map((e) => this.summarize(e));
  }

  get(id: string): NetworkExchange | undefined {
    return this.exchanges.find((e) => e.id === id);
  }

  /** Retrieve a captured body, or null if evicted/absent. */
  body(id: string, kind: "request" | "response"): NetworkBody | null {
    const e = this.get(id);
    if (!e) return null;
    return (kind === "request" ? e.requestBody : e.responseBody) ?? null;
  }

  get size(): number {
    return this.exchanges.length;
  }

  clear(): void {
    this.exchanges.length = 0;
    this.retainedBytes = 0;
    this.emit("clear");
  }

  /** Drop a record's body buffers; returns the bytes reclaimed. */
  private releaseBodies(e: NetworkExchange): number {
    let freed = 0;
    for (const body of [e.requestBody, e.responseBody]) {
      if (body?.data) {
        freed += body.data.length;
        body.data = null;
      }
    }
    return freed;
  }

  private summarize(e: NetworkExchange): NetworkExchangeSummary {
    const { requestBody, responseBody, ...rest } = e;
    return {
      ...rest,
      requestBodySize: requestBody?.size ?? 0,
      responseBodySize: responseBody?.size ?? 0,
      hasRequestBody: !!requestBody?.data,
      hasResponseBody: !!responseBody?.data,
    };
  }

  /** Serialize the full buffer to a HAR 1.2 log object. */
  toHar(): unknown {
    return {
      log: {
        version: "1.2",
        creator: { name: "serve-sim", version: this.version },
        entries: this.exchanges.map((e) => this.harEntry(e)),
      },
    };
  }

  private harEntry(e: NetworkExchange): unknown {
    const httpVersion = e.httpVersion ?? "HTTP/1.1";
    return {
      startedDateTime: new Date(e.startedAt).toISOString(),
      time: e.durationMs,
      request: {
        method: e.method,
        url: e.url,
        httpVersion,
        cookies: [],
        headers: e.requestHeaders,
        queryString: parseQueryString(e.url),
        headersSize: -1,
        bodySize: e.requestBody?.size ?? 0,
        ...(e.requestBody?.data
          ? { postData: { mimeType: contentType(e.requestHeaders) ?? "application/octet-stream", text: bodyText(e.requestBody) } }
          : {}),
      },
      response: {
        status: e.status ?? 0,
        statusText: e.statusText ?? "",
        httpVersion,
        cookies: [],
        headers: e.responseHeaders,
        content: {
          size: e.responseBody?.size ?? 0,
          mimeType: e.mimeType ?? contentType(e.responseHeaders) ?? "application/octet-stream",
          ...(e.responseBody?.data ? { text: bodyText(e.responseBody) } : {}),
        },
        redirectURL: headerValue(e.responseHeaders, "location") ?? "",
        headersSize: -1,
        bodySize: e.responseBody?.size ?? 0,
      },
      cache: {},
      timings: { send: 0, wait: e.durationMs, receive: 0 },
      ...(e.error ? { comment: e.error } : {}),
    };
  }
}

function bodyBytes(body?: NetworkBody | null): number {
  return body?.data?.length ?? 0;
}

function bodyText(body: NetworkBody): string {
  return body.data ? body.data.toString("utf8") : "";
}

function headerValue(headers: NetworkHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function contentType(headers: NetworkHeader[]): string | undefined {
  return headerValue(headers, "content-type");
}

function parseQueryString(url: string): NetworkHeader[] {
  const q = url.indexOf("?");
  if (q === -1) return [];
  const params = new URLSearchParams(url.slice(q + 1));
  const out: NetworkHeader[] = [];
  for (const [name, value] of params) out.push({ name, value });
  return out;
}
