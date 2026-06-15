import { useCallback, useEffect, useMemo, useState } from "react";
import { execOnHost, openHostEventStream, shellEscape } from "../utils/exec";
import { simEndpoint } from "../utils/sim-endpoint";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { SettingSwitch } from "./setting-switch";

export interface NetworkStatus {
  capturing: boolean;
  proxyPort: number;
  systemProxy: { active: boolean; services: string[] };
  trustedUdids: string[];
  caPath: string;
  exchangeCount: number;
  decryptHosts: string[] | null;
}

export interface NetworkHeader {
  name: string;
  value: string;
}

/** Row/summary shape emitted by the SSE stream and `network ls`. */
export interface ExchangeRow {
  id: string;
  method: string;
  url: string;
  host: string;
  scheme: "http" | "https";
  status: number | null;
  statusText?: string;
  httpVersion?: string;
  durationMs: number;
  startedAt?: number;
  mimeType?: string;
  bytesSent?: number;
  bytesReceived?: number;
  requestBodySize?: number;
  responseBodySize?: number;
  hasRequestBody?: boolean;
  hasResponseBody?: boolean;
  requestHeaders?: NetworkHeader[];
  responseHeaders?: NetworkHeader[];
  error?: string | null;
  tlsTunnelOnly?: boolean;
}

interface BodyPayload {
  size: number;
  truncated: boolean;
  base64: string;
}

/** Full record returned by `network get <id>` (adds decoded body payloads). */
export interface ExchangeDetail extends ExchangeRow {
  requestBody?: BodyPayload | null;
  responseBody?: BodyPayload | null;
}

const ROW_CAP = 1000;

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** Parse the `--json` payload from a `serve-sim network` exec, tolerating noise. */
export function parseJsonLine<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const line = trimmed.split("\n").reverse().find((l) => l.startsWith("{") || l.startsWith("["));
    if (!line) return null;
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }
}

/** Prepend a new exchange, dedupe by id, and cap the list length. */
export function prependExchange(list: ExchangeRow[], next: ExchangeRow, cap = ROW_CAP): ExchangeRow[] {
  if (list.some((e) => e.id === next.id)) return list;
  return [next, ...list].slice(0, cap);
}

/** Filter rows by a case-insensitive host/url/method/status substring. */
export function filterRows(rows: ExchangeRow[], needle: string): ExchangeRow[] {
  const q = needle.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.host.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q) ||
      r.method.toLowerCase().includes(q) ||
      String(r.status ?? "").includes(q),
  );
}

export function statusBadge(row: ExchangeRow): { label: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (row.tlsTunnelOnly) return { label: "TLS", tone: "muted" };
  if (row.error) return { label: "ERR", tone: "err" };
  if (row.status == null) return { label: "—", tone: "muted" };
  if (row.status >= 500) return { label: String(row.status), tone: "err" };
  if (row.status >= 400) return { label: String(row.status), tone: "warn" };
  if (row.status >= 300) return { label: String(row.status), tone: "warn" };
  return { label: String(row.status), tone: "ok" };
}

export function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + u.search;
  } catch {
    return url;
  }
}

export function parseQueryParams(url: string): NetworkHeader[] {
  const q = url.indexOf("?");
  if (q === -1) return [];
  const out: NetworkHeader[] = [];
  for (const [name, value] of new URLSearchParams(url.slice(q + 1))) out.push({ name, value });
  return out;
}

export function headerValue(headers: NetworkHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

export type BodyKind = "json" | "image" | "text" | "form" | "binary";

export function classifyBody(contentType: string | undefined): BodyKind {
  const ct = (contentType ?? "").toLowerCase();
  if (!ct) return "text";
  if (ct.includes("json")) return "json";
  if (ct.startsWith("image/")) return "image";
  if (ct.includes("x-www-form-urlencoded")) return "form";
  if (
    ct.startsWith("text/") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("html") ||
    ct.includes("csv")
  )
    return "text";
  return "binary";
}

/** Pretty-print JSON text; returns the input unchanged if it isn't valid JSON. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Build a copy-pasteable cURL command for an exchange. */
export function buildCurl(row: ExchangeRow, bodyText?: string | null): string {
  const parts = [`curl -X ${row.method} ${shellSingleQuote(row.url)}`];
  for (const h of row.requestHeaders ?? []) {
    if (/^(host|content-length)$/i.test(h.name)) continue;
    parts.push(`  -H ${shellSingleQuote(`${h.name}: ${h.value}`)}`);
  }
  if (bodyText) parts.push(`  --data-raw ${shellSingleQuote(bodyText)}`);
  return parts.join(" \\\n");
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Decode a base64 payload to a UTF-8 string (browser). */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** True when decoded text is really binary (NUL bytes or heavy replacement). */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let bad = 0;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0xfffd) bad++;
  return sample.length > 0 && bad / sample.length > 0.1;
}

/** Don't fetch/inline-render bodies above this — offer a streaming download. */
export const PREVIEW_FETCH_LIMIT = 2 * 1024 * 1024; // 2 MB

/** Whether a body is small + textual enough to fetch and preview inline. */
export function isPreviewableBody(kind: BodyKind, size: number): boolean {
  if (kind === "binary") return false;
  return size <= PREVIEW_FETCH_LIMIT;
}

/** Resolve a request/response body's content-type, size, kind, and presence. */
export function bodyMeta(
  row: ExchangeRow,
  which: "request" | "response",
): { hasBody: boolean; size: number; contentType: string | undefined; kind: BodyKind } {
  const contentType =
    which === "response"
      ? row.mimeType ?? headerValue(row.responseHeaders, "content-type")
      : headerValue(row.requestHeaders, "content-type");
  const size = (which === "request" ? row.requestBodySize : row.responseBodySize) ?? 0;
  const hasBody = !!(which === "request" ? row.hasRequestBody : row.hasResponseBody);
  return { hasBody, size, contentType, kind: classifyBody(contentType) };
}

export type BodyRender = { image: string } | { text: string } | { binary: true } | null;

/**
 * Decide how to display a captured body. Binary content-types (and text that
 * decodes to binary) render as a download link rather than mojibake.
 */
export function renderBody(
  payload: BodyPayload | null | undefined,
  kind: BodyKind,
  contentType: string | undefined,
): BodyRender {
  if (!payload?.base64) return null;
  if (kind === "image") return { image: `data:${contentType ?? "image/*"};base64,${payload.base64}` };
  if (kind === "binary") return { binary: true };
  let text: string;
  try {
    text = decodeBase64Utf8(payload.base64);
  } catch {
    return { binary: true };
  }
  if (looksBinary(text)) return { binary: true };
  return { text: kind === "json" ? prettyJson(text) : text };
}

// ── Panel ──────────────────────────────────────────────────────────────────

type DetailTab = "overview" | "headers" | "request" | "response";

export function NetworkInspectorPanel({
  open,
  onClose,
  udid,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  width: number;
}) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [rows, setRows] = useState<ExchangeRow[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [pending, setPending] = useState<null | "toggle" | "trust" | "clear">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ExchangeDetail>>({});

  const cliPrefix = useMemo(() => {
    const bin = window.__SIM_PREVIEW__?.serveSimBin;
    if (!bin) return "serve-sim";
    if (/\.ts$/.test(bin)) return `bun ${shellEscape(bin)}`;
    if (/\.js$/.test(bin)) return `node ${shellEscape(bin)}`;
    return shellEscape(bin);
  }, []);

  const capturing = !!status?.capturing;

  const refreshStatus = useCallback(async () => {
    const res = await execOnHost(`${cliPrefix} network status --json`);
    if (res.exitCode !== 0) return null;
    const parsed = parseJsonLine<NetworkStatus>(res.stdout);
    if (parsed) setStatus(parsed);
    return parsed;
  }, [cliPrefix]);

  const seedRows = useCallback(async () => {
    const res = await execOnHost(`${cliPrefix} network ls --json`);
    if (res.exitCode !== 0) return;
    const list = parseJsonLine<ExchangeRow[]>(res.stdout);
    if (Array.isArray(list)) setRows(list.slice(0, ROW_CAP));
  }, [cliPrefix]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      // Always seed from the store — a previous capture's exchanges persist
      // even while capture is off, so the list shouldn't open empty.
      await Promise.all([refreshStatus(), seedRows()]);
      void cancelled;
    })();
    const timer = setInterval(() => { void refreshStatus(); }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, refreshStatus, seedRows]);

  useEffect(() => {
    if (!open || !capturing) return;
    const stream = openHostEventStream(simEndpoint("api/network/events"));
    stream.onmessage = (e) => {
      const row = parseJsonLine<ExchangeRow>(e.data);
      if (row?.id) setRows((prev) => prependExchange(prev, row));
    };
    return () => stream.close();
  }, [open, capturing]);

  // Fetch full detail (incl. bodies) on demand when a body tab is opened.
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const selectedDetail = selectedId ? details[selectedId] : undefined;
  useEffect(() => {
    if (!selectedId || (tab !== "request" && tab !== "response")) return;
    if (details[selectedId]) return;
    const row = rows.find((r) => r.id === selectedId);
    if (!row) return;
    // Skip the fetch entirely for binary / oversized bodies — the inline
    // base64 round-trip and render are what locked up the tab. The download
    // link is served straight from the summary instead.
    const meta = bodyMeta(row, tab);
    if (!meta.hasBody || !isPreviewableBody(meta.kind, meta.size)) return;
    let cancelled = false;
    void (async () => {
      const res = await execOnHost(`${cliPrefix} network get ${shellEscape(selectedId)} --json`);
      if (cancelled || res.exitCode !== 0) return;
      const d = parseJsonLine<ExchangeDetail>(res.stdout);
      if (d) setDetails((prev) => ({ ...prev, [selectedId]: d }));
    })();
    return () => { cancelled = true; };
  }, [selectedId, tab, details, cliPrefix, rows]);

  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200);
  }, []);

  const toggleCapture = useCallback(async () => {
    setPending("toggle");
    setError(null);
    try {
      const verb = capturing ? "stop" : `start -d ${udid}`;
      const res = await execOnHost(`${cliPrefix} network ${verb} --json`);
      if (res.exitCode !== 0) { setError(res.stderr.trim() || res.stdout.trim() || "Command failed"); return; }
      await refreshStatus();
      if (!capturing) await seedRows();
    } finally { setPending(null); }
  }, [capturing, cliPrefix, udid, refreshStatus, seedRows]);

  const trustSim = useCallback(async () => {
    setPending("trust");
    setError(null);
    try {
      const res = await execOnHost(`${cliPrefix} network trust -d ${udid}`);
      if (res.exitCode !== 0) { setError(res.stderr.trim() || "Trust failed (needs Xcode simctl)"); return; }
      await refreshStatus();
    } finally { setPending(null); }
  }, [cliPrefix, udid, refreshStatus]);

  const clearRows = useCallback(async () => {
    setPending("clear");
    try {
      await execOnHost(`${cliPrefix} network clear`);
      setRows([]); setSelectedId(null); setDetails({});
    } finally { setPending(null); }
  }, [cliPrefix]);

  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const trusted = !!status && status.trustedUdids.includes(udid);
  const harHref = simEndpoint("api/network/har");

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <div className="flex items-center gap-2">
          <PanelTitle>Network</PanelTitle>
          <span className="text-[10px] font-mono text-white/40">
            {capturing ? `${rows.length} captured` : "idle"}
          </span>
        </div>
        <PanelCloseButton onClick={onClose} title="Close network inspector" />
      </PanelHeader>

      {/* Toolbar */}
      <div className="shrink-0 flex flex-col gap-2 px-3 pb-2 border-b border-white/8">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <SettingSwitch
              label="Toggle network capture"
              checked={capturing}
              disabled={pending !== null}
              onChange={() => void toggleCapture()}
            />
            <span className="text-[11px] text-white/75">
              {pending === "toggle" ? "Working…" : capturing ? "Capturing" : "Capture off"}
            </span>
          </div>
          <span className="flex-1" />
          <StatusChip ok={!!status?.systemProxy.active} label="proxy" />
          <StatusChip ok={trusted} label="CA" />
          {!trusted && (
            <button
              onClick={() => void trustSim()}
              disabled={pending !== null}
              className="text-[10px] px-2 py-[3px] rounded-full bg-white/[0.06] border border-white/12 text-white/85 hover:bg-white/[0.1] cursor-pointer disabled:opacity-50"
              title="Install the serve-sim CA into this simulator (relaunch the app afterwards to decrypt HTTPS)"
            >
              {pending === "trust" ? "Installing…" : "Install CA"}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter((e.target as HTMLInputElement).value)}
            placeholder="Filter host / path / method / status"
            className="flex-1 min-w-0 bg-white/[0.04] border border-white/8 rounded-[7px] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/35 outline-none focus:border-white/20"
          />
          <a
            href={harHref}
            download="serve-sim.har"
            className="text-[11px] px-2.5 py-1.5 rounded-[7px] bg-white/[0.06] border border-white/12 text-white/85 hover:bg-white/[0.1] no-underline"
            title="Download the capture as a HAR 1.2 file"
          >
            Export HAR
          </a>
          <button
            onClick={() => void clearRows()}
            disabled={pending !== null || rows.length === 0}
            className="text-[11px] px-2.5 py-1.5 rounded-[7px] bg-white/[0.04] border border-white/8 text-white/85 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40"
            title="Clear captured requests"
          >
            Clear
          </button>
        </div>

        {error && (
          <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md break-words" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Scrolling table (top) + stacked detail (bottom) */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Request table */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <RequestTableHeader />
          <div className="flex-1 min-h-0 overflow-auto">
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-white/40">
                {capturing ? "Waiting for traffic…" : rows.length ? "No matches." : "No requests captured yet."}
              </div>
            ) : (
              visible.map((row) => (
                <RequestTableRow
                  key={row.id}
                  row={row}
                  selected={row.id === selectedId}
                  onSelect={() => { setSelectedId(row.id); setTab("overview"); }}
                />
              ))
            )}
          </div>
        </div>

        {/* Stacked detail */}
        {selected && (
          <div className="shrink-0 h-[46%] min-h-[180px] flex flex-col border-t border-white/10 bg-panel-deep/30">
            <DetailHeader
              row={selected}
              onCopyCurl={() => copy("curl", buildCurl(selected, curlBody(selectedDetail)))}
              copied={copied === "curl"}
              onClose={() => setSelectedId(null)}
            />
            <DetailTabs tab={tab} onTab={setTab} />
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {tab === "overview" && <OverviewTab row={selected} />}
                {tab === "headers" && (
                  <>
                    <HeaderTable title="Request headers" headers={selected.requestHeaders} onCopy={(t) => copy("reqh", t)} />
                    <HeaderTable title="Response headers" headers={selected.responseHeaders} onCopy={(t) => copy("resh", t)} />
                  </>
                )}
                {tab === "request" && (() => {
                  const meta = bodyMeta(selected, "request");
                  return (
                    <>
                      <QueryTable url={selected.url} />
                      <BodyView
                        title="Request body"
                        contentType={meta.contentType}
                        size={meta.size}
                        hasBody={meta.hasBody}
                        previewable={isPreviewableBody(meta.kind, meta.size)}
                        payload={selectedDetail?.requestBody}
                        downloadHref={simEndpoint(`api/network/requests/${selected.id}/body?kind=request`)}
                        onCopy={(t) => copy("reqb", t)}
                        copied={copied === "reqb"}
                      />
                    </>
                  );
                })()}
                {tab === "response" && (() => {
                  const meta = bodyMeta(selected, "response");
                  return (
                    <BodyView
                      title="Response body"
                      contentType={meta.contentType}
                      size={meta.size}
                      hasBody={meta.hasBody}
                      previewable={isPreviewableBody(meta.kind, meta.size)}
                      payload={selectedDetail?.responseBody}
                      downloadHref={simEndpoint(`api/network/requests/${selected.id}/body?kind=response`)}
                      onCopy={(t) => copy("resb", t)}
                      copied={copied === "resb"}
                    />
                  );
                })()}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function curlBody(detail: ExchangeDetail | undefined): string | null {
  const b = detail?.requestBody;
  if (!b?.base64) return null;
  const kind = classifyBody(headerValue(detail?.requestHeaders, "content-type"));
  if (kind === "binary" || kind === "image") return null;
  try { return decodeBase64Utf8(b.base64); } catch { return null; }
}

// ── Subcomponents ──────────────────────────────────────────────────────────

// Shared column template for the request table header + rows.
const TABLE_COLS = "grid grid-cols-[92px_46px_minmax(0,1fr)_76px_62px_62px] gap-2 px-2.5";

function toneText(tone: ReturnType<typeof statusBadge>["tone"]): string {
  return tone === "ok" ? "text-success-emerald"
    : tone === "warn" ? "text-warning-soft"
    : tone === "err" ? "text-danger-soft"
    : "text-white/45";
}
function toneDot(tone: ReturnType<typeof statusBadge>["tone"]): string {
  return tone === "ok" ? "bg-success-emerald"
    : tone === "warn" ? "bg-warning-soft"
    : tone === "err" ? "bg-danger-soft"
    : "bg-white/30";
}

function RequestTableHeader() {
  return (
    <div className={`${TABLE_COLS} shrink-0 py-1.5 border-b border-white/10 bg-panel/60 text-[9px] uppercase tracking-[0.06em] text-white/40`}>
      <span>Method</span>
      <span>Code</span>
      <span>URL</span>
      <span>Time</span>
      <span className="text-right">Duration</span>
      <span className="text-right">Size</span>
    </div>
  );
}

function RequestTableRow({ row, selected, onSelect }: { row: ExchangeRow; selected: boolean; onSelect: () => void }) {
  const badge = statusBadge(row);
  const size = row.responseBodySize ?? row.bytesReceived;
  const time = row.startedAt ? new Date(row.startedAt).toLocaleTimeString(undefined, { hour12: false }) : "";
  return (
    <button
      onClick={onSelect}
      className={`${TABLE_COLS} w-full items-center py-1 text-left border-b border-white/[0.04] hover:bg-white/[0.04] cursor-pointer ${selected ? "bg-white/[0.08]" : ""}`}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span className={`size-1.5 rounded-full shrink-0 ${toneDot(badge.tone)}`} />
        <span className="text-[10px] font-mono font-semibold text-white/75 truncate">{row.method}</span>
      </span>
      <span className={`text-[10px] font-mono ${toneText(badge.tone)}`}>{badge.label}</span>
      <span className="min-w-0 truncate text-[11px] font-mono text-white/85">
        {row.scheme === "https" ? "🔒 " : ""}{row.host}
        <span className="text-white/45">{pathOf(row.url)}</span>
      </span>
      <span className="text-[10px] font-mono text-white/45 truncate">{time}</span>
      <span className="text-[10px] font-mono text-white/45 text-right">{row.durationMs ? `${Math.round(row.durationMs)}ms` : ""}</span>
      <span className="text-[10px] font-mono text-white/35 text-right">{formatBytes(size)}</span>
    </button>
  );
}

function DetailHeader({
  row,
  onCopyCurl,
  copied,
  onClose,
}: {
  row: ExchangeRow;
  onCopyCurl: () => void;
  copied: boolean;
  onClose: () => void;
}) {
  const badge = statusBadge(row);
  const statusLabel = row.tlsTunnelOnly
    ? "Tunnel"
    : `${row.status ?? (row.error ? "Error" : "—")}${row.statusText ? ` ${row.statusText}` : ""}`;
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/8">
      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-white/[0.08] text-white/80">{row.method}</span>
      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] ${toneText(badge.tone)}`}>{statusLabel}</span>
      <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-white/80" title={row.url}>{row.url}</span>
      <CopyButton label={copied ? "Copied" : "Copy as cURL"} onClick={onCopyCurl} />
      <button
        onClick={onClose}
        className="shrink-0 text-white/45 hover:text-white/85 cursor-pointer text-[14px] leading-none px-1"
        aria-label="Close detail"
        title="Close detail"
      >
        ×
      </button>
    </div>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-[3px] rounded-full border text-[10px] ${
        ok ? "bg-success-emerald/10 border-success-emerald/25 text-success-emerald" : "bg-white/[0.04] border-white/10 text-white/45"
      }`}
      title={ok ? `${label} active` : `${label} inactive`}
    >
      <span className={`size-1.5 rounded-full ${ok ? "bg-success-emerald" : "bg-white/30"}`} />
      {label}
    </span>
  );
}

function DetailTabs({ tab, onTab }: { tab: DetailTab; onTab: (t: DetailTab) => void }) {
  const tabs: { id: DetailTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "headers", label: "Headers" },
    { id: "request", label: "Request" },
    { id: "response", label: "Response" },
  ];
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-white/8" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onTab(t.id)}
          className={`text-[11px] px-2.5 py-1 rounded-md cursor-pointer ${
            tab === t.id ? "bg-white/[0.12] text-white" : "text-white/55 hover:text-white/85 hover:bg-white/[0.05]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Field({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  if (!v) return null;
  return (
    <div className="flex gap-2 py-[3px] border-b border-white/[0.04] last:border-b-0">
      <span className="shrink-0 w-24 text-[10px] text-white/45">{k}</span>
      <span className={`flex-1 min-w-0 break-all text-[11px] text-white/85 ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

function OverviewTab({ row }: { row: ExchangeRow }) {
  return (
    <div className="flex flex-col gap-2">
      {row.error && <div className="text-[11px] text-danger-soft">Error: {row.error}</div>}
      {row.tlsTunnelOnly && (
        <div className="text-[10px] text-white/45 leading-[1.5]">
          Encrypted tunnel — not decrypted. The app pinned its certificate, sent a client
          certificate, or the host is excluded from decryption.
        </div>
      )}
      <div className="flex flex-col">
        <Field k="Host" v={row.host} />
        <Field k="Scheme" v={row.scheme} />
        <Field k="Protocol" v={row.httpVersion ?? ""} />
        <Field k="Duration" v={row.durationMs ? `${Math.round(row.durationMs)} ms` : ""} />
        <Field k="Request size" v={formatBytes(row.requestBodySize ?? row.bytesSent)} />
        <Field k="Response size" v={formatBytes(row.responseBodySize ?? row.bytesReceived)} />
        <Field k="Content-Type" v={row.mimeType ?? headerValue(row.responseHeaders, "content-type") ?? ""} />
        <Field k="Started" v={row.startedAt ? new Date(row.startedAt).toLocaleTimeString() : ""} />
      </div>
    </div>
  );
}

function HeaderTable({ title, headers, onCopy }: { title: string; headers?: NetworkHeader[]; onCopy?: (t: string) => void }) {
  if (!headers || headers.length === 0) {
    return (
      <div className="mb-3">
        <div className="text-[9px] uppercase tracking-[0.08em] text-white/40 mb-1">{title}</div>
        <div className="text-[10px] text-white/35">None</div>
      </div>
    );
  }
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[9px] uppercase tracking-[0.08em] text-white/40">{title}</div>
        {onCopy && (
          <button
            onClick={() => onCopy(headers.map((h) => `${h.name}: ${h.value}`).join("\n"))}
            className="text-[9px] text-white/45 hover:text-white/80 cursor-pointer"
            title="Copy headers"
          >
            copy
          </button>
        )}
      </div>
      <div className="flex flex-col gap-px font-mono text-[10px]">
        {headers.map((h, i) => (
          <div key={i} className="flex gap-1.5 py-[1px]">
            <span className="text-accent/80 shrink-0">{h.name}:</span>
            <span className="text-white/80 break-all">{h.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QueryTable({ url }: { url: string }) {
  const params = useMemo(() => parseQueryParams(url), [url]);
  if (params.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-[9px] uppercase tracking-[0.08em] text-white/40 mb-1">Query parameters</div>
      <div className="flex flex-col gap-px font-mono text-[10px]">
        {params.map((p, i) => (
          <div key={i} className="flex gap-1.5 py-[1px]">
            <span className="text-accent/80 shrink-0">{p.name}:</span>
            <span className="text-white/80 break-all">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Cap how much text we drop into a single <pre>. A multi-MB string with
// break-all forces the browser to compute a break opportunity per character,
// which locks up the tab — so we render a prefix and offer a download instead.
const MAX_RENDER_CHARS = 256 * 1024;

function BodyView({
  title,
  contentType,
  size,
  payload,
  hasBody,
  previewable,
  downloadHref,
  onCopy,
  copied,
}: {
  title: string;
  contentType: string | undefined;
  size: number;
  payload: BodyPayload | null | undefined;
  hasBody: boolean;
  previewable: boolean;
  downloadHref: string;
  onCopy: (t: string) => void;
  copied: boolean;
}) {
  const kind = classifyBody(contentType);
  const rendered = useMemo(() => renderBody(payload, kind, contentType), [payload, kind, contentType]);

  const fullText = rendered && "text" in rendered ? rendered.text : null;
  const tooLong = fullText != null && fullText.length > MAX_RENDER_CHARS;
  const shownText = tooLong ? fullText!.slice(0, MAX_RENDER_CHARS) : fullText;
  const displaySize = payload?.size ?? size;

  const downloadLink = (
    <a href={downloadHref} download className="text-accent underline">
      download
    </a>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[9px] uppercase tracking-[0.08em] text-white/40">
          {title}
          {contentType ? <span className="text-white/30"> · {contentType.split(";")[0]}</span> : null}
          {displaySize ? <span className="text-white/30"> · {formatBytes(displaySize)}{payload?.truncated ? " (truncated)" : ""}</span> : null}
        </div>
        {fullText != null && (
          <button onClick={() => onCopy(fullText)} className="text-[9px] text-white/45 hover:text-white/80 cursor-pointer">
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
      {!hasBody ? (
        <div className="text-[10px] text-white/35">No body</div>
      ) : !previewable ? (
        <div className="text-[10px] text-white/45">
          {kind === "binary" ? "Binary" : "Large"} body · {formatBytes(displaySize)} — not previewed to keep the UI responsive. {downloadLink}
        </div>
      ) : !payload ? (
        <div className="text-[10px] text-white/35">Loading…</div>
      ) : rendered && "image" in rendered ? (
        <img src={rendered.image} alt="response" className="max-w-full max-h-[360px] rounded border border-white/10" />
      ) : shownText != null ? (
        <>
          <pre className="font-mono text-[10px] leading-[1.5] text-white/85 bg-panel-deep rounded-md p-2 overflow-auto max-h-[420px] whitespace-pre-wrap break-all">{shownText}</pre>
          {tooLong && (
            <div className="mt-1 text-[10px] text-white/40">
              Showing first {formatBytes(MAX_RENDER_CHARS)} of {formatBytes(displaySize)}. {downloadLink} the full body.
            </div>
          )}
        </>
      ) : (
        <div className="text-[10px] text-white/35">
          Binary {formatBytes(displaySize)} — not previewable. {downloadLink}
        </div>
      )}
    </div>
  );
}

function CopyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] px-2 py-[3px] rounded-md bg-white/[0.06] border border-white/12 text-white/85 hover:bg-white/[0.1] cursor-pointer"
    >
      {label}
    </button>
  );
}
