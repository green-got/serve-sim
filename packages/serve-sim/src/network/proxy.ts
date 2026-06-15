/**
 * MITM HTTP/HTTPS proxy for the network inspector.
 *
 * A front HTTP server accepts both absolute-form HTTP proxy requests and HTTPS
 * CONNECT tunnels. Each CONNECT tunnel is bridged to a per-host internal
 * `https.Server` whose default cert is a leaf minted for that host and signed
 * by the serve-sim CA, so the decrypted plaintext flows through the same
 * request handler as plain HTTP. (Bridging to a real listening https.Server —
 * rather than injecting a TLSSocket via emit("connection") — is what keeps this
 * working under both Node and Bun, whose native HTTP server ignores injected
 * sockets.) Every completed request/response pair is recorded as a
 * NetworkExchange.
 *
 * The simulator routes here because we point the macOS system proxy at this
 * port (see system-proxy.ts); HTTPS decrypts because the CA is trusted in the
 * sim's keychain (see trust.ts).
 */
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import zlib from "zlib";
import { randomUUID } from "crypto";
import { URL } from "url";
import { leafCertForHost, ensureCA } from "./ca";
import { debugNet } from "../debug";
import type { NetworkStore, NetworkExchange, NetworkHeader, NetworkBody } from "./store";

export const DEFAULT_PROXY_PORT = 9270;
const BODY_CAP_BYTES = 5 * 1024 * 1024; // retain up to 5 MB per body
const MAX_TLS_SERVERS = 128; // bound ephemeral ports/memory; evict oldest host

export interface ProxyOptions {
  port?: number;
  host?: string;
  store: NetworkStore;
  /** Optional allow-list of hosts to decrypt; others tunnel opaquely. */
  decryptHosts?: string[] | null;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
}

export class NetworkProxy {
  private readonly store: NetworkStore;
  private readonly port: number;
  private readonly host: string;
  private readonly decryptHosts: string[] | null;
  private front: http.Server | null = null;
  /** Per-host TLS terminators, insertion-ordered for FIFO eviction. */
  private readonly tlsServers = new Map<string, { server: https.Server; port: number }>();

  constructor(opts: ProxyOptions) {
    this.store = opts.store;
    this.port = opts.port ?? DEFAULT_PROXY_PORT;
    this.host = opts.host ?? "127.0.0.1";
    this.decryptHosts = opts.decryptHosts ?? null;
  }

  get listenPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    if (this.front) return;
    ensureCA();

    this.front = http.createServer((req, res) => {
      // Absolute-form (plain HTTP proxy) vs decrypted-from-TLS (origin-form).
      const isTls = (req.socket as tls.TLSSocket).encrypted === true;
      this.handleRequest(req, res, isTls ? "https" : "http");
    });
    this.front.on("connect", (req, socket) => this.handleConnect(req, socket as net.Socket));
    this.front.on("clientError", (_e, socket) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await listen(this.front, this.port, this.host);
  }

  async stop(): Promise<void> {
    await Promise.all([
      closeServer(this.front),
      ...[...this.tlsServers.values()].map((t) => closeServer(t.server)),
    ]);
    this.tlsServers.clear();
    this.front = null;
  }

  status(): ProxyStatus {
    return { running: !!this.front, port: this.front ? this.port : null };
  }

  // ── CONNECT tunnels ──────────────────────────────────────────────────────

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket): void {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;
    const shouldDecrypt = this.shouldDecrypt(host ?? "");

    clientSocket.on("error", (err) => debugNet("CONNECT %s: client socket error: %o", host, err));
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (!shouldDecrypt) {
      // Opaque pass-through: pipe bytes to the real upstream, record a tunnel.
      const upstream = net.connect(port, host ?? "", () => {
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", (err) => {
        debugNet("CONNECT %s: opaque upstream error: %o", host, err);
        clientSocket.destroy();
      });
      this.recordTunnelOnly(host ?? "");
      return;
    }

    // Bridge the raw tunnel to a per-host https.Server that terminates TLS with
    // a leaf cert for this host. We know the host from the CONNECT line, so no
    // SNI is needed. Decrypted requests reach handleRequest as origin-form.
    void this.bridgeToTls(host ?? "", clientSocket);
  }

  private async bridgeToTls(host: string, clientSocket: net.Socket): Promise<void> {
    let entry: { server: https.Server; port: number };
    try {
      entry = await this.ensureTlsServer(host);
    } catch (err) {
      debugNet("bridgeToTls: TLS terminator for %s failed, tunneling opaquely: %o", host, err);
      this.recordTunnelOnly(host);
      clientSocket.destroy();
      return;
    }
    const bridge = net.connect(entry.port, "127.0.0.1", () => {
      clientSocket.pipe(bridge);
      bridge.pipe(clientSocket);
    });
    bridge.on("error", (err) => {
      debugNet("bridgeToTls %s: bridge socket error: %o", host, err);
      clientSocket.destroy();
    });
  }

  /** Get-or-create the TLS terminator for `host`, evicting the oldest at cap. */
  private async ensureTlsServer(host: string): Promise<{ server: https.Server; port: number }> {
    const existing = this.tlsServers.get(host);
    if (existing) return existing;

    const leaf = leafCertForHost(host);
    const server = https.createServer({ cert: leaf.cert, key: leaf.key }, (req, res) =>
      this.handleRequest(req, res, "https"),
    );
    server.on("tlsClientError", (err) => {
      debugNet("TLS terminator %s: tlsClientError, recording tunnel-only: %o", host, err);
      this.recordTunnelOnly(host);
    });
    await listen(server, 0, "127.0.0.1");
    const port = (server.address() as net.AddressInfo).port;
    const entry = { server, port };
    this.tlsServers.set(host, entry);

    if (this.tlsServers.size > MAX_TLS_SERVERS) {
      const oldestHost = this.tlsServers.keys().next().value as string;
      const oldest = this.tlsServers.get(oldestHost);
      this.tlsServers.delete(oldestHost);
      if (oldest) void closeServer(oldest.server);
    }
    return entry;
  }

  // ── Request/response capture ─────────────────────────────────────────────

  private handleRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    scheme: "http" | "https",
  ): void {
    const startedAt = Date.now();
    const startHr = process.hrtime.bigint();

    const { host, port, path } = resolveTarget(clientReq, scheme);
    if (!host) {
      clientRes.writeHead(400);
      clientRes.end("Bad proxy request");
      return;
    }

    const reqHeaders = toHeaderList(clientReq.rawHeaders);
    const reqBody = new BodyCollector();
    clientReq.on("data", (c: Buffer) => reqBody.push(c));

    const upstreamMod = scheme === "https" ? https : http;
    const upstreamReq = upstreamMod.request(
      {
        host,
        port,
        method: clientReq.method,
        path,
        headers: clientReq.headers,
        // We are the trust anchor for the sim, but upstream verification should
        // still use the real system roots.
        rejectUnauthorized: false,
        servername: host,
      },
      (upstreamRes) => {
        const resHeaders = toHeaderList(upstreamRes.rawHeaders);
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);

        const resBody = new BodyCollector();
        upstreamRes.on("data", (c: Buffer) => resBody.push(c));
        upstreamRes.pipe(clientRes);

        upstreamRes.on("end", () => {
          const durationMs = hrToMs(startHr);
          this.store.add(
            this.buildExchange({
              startedAt,
              durationMs,
              method: clientReq.method ?? "GET",
              scheme,
              host,
              port,
              path,
              status: upstreamRes.statusCode ?? null,
              statusText: upstreamRes.statusMessage,
              httpVersion: `HTTP/${upstreamRes.httpVersion ?? "1.1"}`,
              reqHeaders,
              resHeaders,
              reqBody: reqBody.toBody(),
              resBody: resBody.toBody(decodeEncoding(upstreamRes.headers["content-encoding"])),
              mimeType: headerValue(resHeaders, "content-type"),
            }),
          );
        });
      },
    );

    upstreamReq.on("error", (err) => {
      const durationMs = hrToMs(startHr);
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end("Upstream error");
      this.store.add(
        this.buildExchange({
          startedAt,
          durationMs,
          method: clientReq.method ?? "GET",
          scheme,
          host,
          port,
          path,
          status: null,
          reqHeaders,
          resHeaders: [],
          reqBody: reqBody.toBody(),
          resBody: null,
          error: err.message,
        }),
      );
    });

    clientReq.pipe(upstreamReq);
  }

  private buildExchange(p: {
    startedAt: number;
    durationMs: number;
    method: string;
    scheme: "http" | "https";
    host: string;
    port: number;
    path: string;
    status: number | null;
    statusText?: string;
    httpVersion?: string;
    reqHeaders: NetworkHeader[];
    resHeaders: NetworkHeader[];
    reqBody: NetworkBody | null;
    resBody: NetworkBody | null;
    mimeType?: string;
    error?: string;
  }): NetworkExchange {
    const portSuffix =
      (p.scheme === "https" && p.port === 443) || (p.scheme === "http" && p.port === 80)
        ? ""
        : `:${p.port}`;
    return {
      id: randomUUID(),
      startedAt: p.startedAt,
      durationMs: p.durationMs,
      method: p.method,
      url: `${p.scheme}://${p.host}${portSuffix}${p.path}`,
      host: p.host,
      scheme: p.scheme,
      status: p.status,
      statusText: p.statusText,
      httpVersion: p.httpVersion,
      requestHeaders: p.reqHeaders,
      responseHeaders: p.resHeaders,
      requestBody: p.reqBody,
      responseBody: p.resBody,
      mimeType: p.mimeType,
      bytesSent: p.reqBody?.size ?? 0,
      bytesReceived: p.resBody?.size ?? 0,
      error: p.error ?? null,
    };
  }

  private recordTunnelOnly(host: string): void {
    this.store.add({
      id: randomUUID(),
      startedAt: Date.now(),
      durationMs: 0,
      method: "CONNECT",
      url: `https://${host}`,
      host,
      scheme: "https",
      status: null,
      requestHeaders: [],
      responseHeaders: [],
      bytesSent: 0,
      bytesReceived: 0,
      tlsTunnelOnly: true,
    });
  }

  private shouldDecrypt(host: string): boolean {
    if (!this.decryptHosts || this.decryptHosts.length === 0) return true;
    return this.decryptHosts.some((h) => host === h || host.endsWith("." + h));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

class BodyCollector {
  private chunks: Buffer[] = [];
  private total = 0;
  private capped = false;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.capped) return;
    if (this.total > BODY_CAP_BYTES) {
      this.capped = true;
      const room = BODY_CAP_BYTES - (this.total - chunk.length);
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
    } else {
      this.chunks.push(chunk);
    }
  }

  /** Produce a NetworkBody, optionally decompressing the captured copy. */
  toBody(decode?: (b: Buffer) => Buffer): NetworkBody | null {
    if (this.total === 0) return null;
    let data: Buffer = Buffer.concat(this.chunks);
    if (decode && !this.capped) {
      try {
        data = decode(data);
      } catch (err) {
        /* keep raw bytes if decode fails */
        debugNet("BodyCollector.toBody: content decode failed, keeping raw bytes: %o", err);
      }
    }
    return { data, size: this.total, truncated: this.capped };
  }
}

function decodeEncoding(encoding?: string): ((b: Buffer) => Buffer) | undefined {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
      return (b) => zlib.gunzipSync(b);
    case "deflate":
      return (b) => zlib.inflateSync(b);
    case "br":
      return (b) => zlib.brotliDecompressSync(b);
    default:
      return undefined;
  }
}

function resolveTarget(
  req: http.IncomingMessage,
  scheme: "http" | "https",
): { host: string; port: number; path: string } {
  const raw = req.url ?? "/";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
    };
  }
  // Origin-form (came in over a terminated TLS tunnel): host from Host header.
  const hostHeader = req.headers.host ?? "";
  const [host, portStr] = hostHeader.split(":");
  return {
    host: host ?? "",
    port: Number(portStr) || (scheme === "https" ? 443 : 80),
    path: raw,
  };
}

function toHeaderList(rawHeaders: string[]): NetworkHeader[] {
  const out: NetworkHeader[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    out.push({ name: rawHeaders[i]!, value: rawHeaders[i + 1]! });
  }
  return out;
}

function headerValue(headers: NetworkHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function hrToMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server | http.Server | tls.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    // CFNetwork keeps proxy connections alive, so a plain close() blocks until
    // every socket drains — which can be never. Force them shut so stop()
    // returns promptly; the OS tears down the half-open tunnels.
    (server as http.Server).closeAllConnections?.();
    server.close(() => resolve());
    // Belt-and-braces: don't let a missed socket hang the shutdown.
    setTimeout(resolve, 1000).unref?.();
  });
}
