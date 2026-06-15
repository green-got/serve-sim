/**
 * `serve-sim network …` CLI. Drives the network inspector that lives in the
 * running preview server (started by `serve-sim`), discovered via the
 * STATE_DIR/preview.json file that serve() publishes. Mutating calls carry the
 * preview server's bearer token.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { debugNet } from "../debug";

const STATE_DIR = join(tmpdir(), "serve-sim");
const PREVIEW_STATE_FILE = join(STATE_DIR, "preview.json");

interface PreviewState {
  url: string;
  execToken: string;
  device?: string | null;
}

export interface NetworkCliArgs {
  command: "start" | "stop" | "status" | "ls" | "tail" | "export" | "trust" | "untrust" | "clear" | "get";
  device?: string;
  decrypt?: string[];
  json: boolean;
  uninstall: boolean;
  file?: string;
  id?: string;
}

export function parseNetworkArgs(argv: string[]): NetworkCliArgs {
  const out: NetworkCliArgs = { command: "status", json: false, uninstall: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "-d" || a === "--device") out.device = argv[++i];
    else if (a === "--decrypt") out.decrypt = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else positional.push(a);
  }
  const cmd = positional[0];
  const known = ["start", "stop", "status", "ls", "tail", "export", "trust", "untrust", "clear", "get"] as const;
  if (cmd && (known as readonly string[]).includes(cmd)) {
    out.command = cmd as NetworkCliArgs["command"];
  } else if (cmd) {
    throw new Error(`Unknown network command: ${cmd}`);
  }
  if (out.command === "export") out.file = positional[1];
  if (out.command === "get") out.id = positional[1];
  return out;
}

function readPreviewState(): PreviewState {
  if (!existsSync(PREVIEW_STATE_FILE)) {
    throw new Error(
      "No serve-sim preview server is running. Start one with `serve-sim` (it hosts the network inspector), then retry.",
    );
  }
  return JSON.parse(readFileSync(PREVIEW_STATE_FILE, "utf8"));
}

async function api(
  state: PreviewState,
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth) headers["Authorization"] = `Bearer ${state.execToken}`;
  return fetch(`${state.url}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export async function networkCli(argv: string[]): Promise<void> {
  let args: NetworkCliArgs;
  try {
    args = parseNetworkArgs(argv);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  let state: PreviewState;
  try {
    state = readPreviewState();
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  switch (args.command) {
    case "start": {
      const res = await api(state, "/api/network/start", {
        method: "POST",
        auth: true,
        body: { udid: args.device, decryptHosts: args.decrypt ?? null },
      });
      const data: any = await res.json();
      if (!res.ok || !data.ok) return fail(data?.error ?? `HTTP ${res.status}`);
      printStatus(data.status, args.json);
      if (!args.json) {
        console.log("");
        console.log("📡 Capture started. The simulator's HTTPS will decrypt only after the");
        console.log("   CA is trusted — relaunch the app under test (or reset the sim) to pick it up.");
      }
      return;
    }
    case "stop": {
      const res = await api(state, `/api/network/stop${args.uninstall ? "?uninstall=1" : ""}`, {
        method: "POST",
        auth: true,
        body: {},
      });
      const data: any = await res.json();
      if (!res.ok || !data.ok) return fail(data?.error ?? `HTTP ${res.status}`);
      printStatus(data.status, args.json);
      return;
    }
    case "trust":
    case "untrust": {
      const res = await api(state, `/api/network/${args.command}`, {
        method: "POST",
        auth: true,
        body: { udid: args.device },
      });
      const data: any = await res.json();
      if (!res.ok || !data.ok) return fail(data?.error ?? `HTTP ${res.status}`);
      console.log(args.json ? JSON.stringify(data) : `✅ ${args.command} ok`);
      return;
    }
    case "status": {
      const res = await api(state, "/api/network/status");
      const status: any = await res.json();
      printStatus(status, args.json);
      return;
    }
    case "ls": {
      const res = await api(state, "/api/network/requests?limit=100");
      const data: any = await res.json();
      if (args.json) {
        console.log(JSON.stringify(data.exchanges, null, 2));
        return;
      }
      printExchangeTable(data.exchanges);
      return;
    }
    case "export": {
      if (!args.file) return fail("Usage: serve-sim network export <file.har>");
      const res = await api(state, "/api/network/har");
      const text = await res.text();
      writeFileSync(args.file, text);
      console.log(`Wrote ${args.file}`);
      return;
    }
    case "get": {
      if (!args.id) return fail("Usage: serve-sim network get <id>");
      const res = await api(state, `/api/network/requests/${encodeURIComponent(args.id)}`);
      if (res.status === 404) return fail("Not found");
      const data = await res.text();
      console.log(data);
      return;
    }
    case "clear": {
      const res = await api(state, "/api/network/requests", { method: "DELETE", auth: true, body: {} });
      const data: any = await res.json();
      if (!res.ok || !data.ok) return fail(data?.error ?? `HTTP ${res.status}`);
      console.log(args.json ? JSON.stringify(data) : "Cleared.");
      return;
    }
    case "tail": {
      await tailEvents(state);
      return;
    }
  }
}

async function tailEvents(state: PreviewState): Promise<void> {
  const res = await fetch(`${state.url}/api/network/events`);
  if (!res.body) return fail("No event stream");
  console.log("Listening for network exchanges (Ctrl+C to stop)…");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const e = JSON.parse(line.slice(6));
        console.log(formatExchangeRow(e));
      } catch (err) {
        debugNet("tail: skipping unparseable SSE frame: %o", err);
      }
    }
  }
}

function printStatus(status: any, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`capturing:     ${status.capturing ? "yes" : "no"}`);
  console.log(`proxy port:    ${status.proxyPort}`);
  console.log(`system proxy:  ${status.systemProxy.active ? `active (${status.systemProxy.services.join(", ")})` : "inactive"}`);
  console.log(`trusted sims:  ${status.trustedUdids.length ? status.trustedUdids.join(", ") : "none"}`);
  console.log(`exchanges:     ${status.exchangeCount}`);
  console.log(`CA cert:       ${status.caPath}`);
  if (status.decryptHosts?.length) console.log(`decrypt hosts: ${status.decryptHosts.join(", ")}`);
}

function printExchangeTable(exchanges: any[]): void {
  if (!exchanges.length) {
    console.log("No exchanges captured yet.");
    return;
  }
  for (const e of exchanges) console.log(formatExchangeRow(e));
}

function formatExchangeRow(e: any): string {
  const status = e.tlsTunnelOnly ? "TUNNEL" : e.status ?? (e.error ? "ERR" : "—");
  const dur = e.durationMs ? `${Math.round(e.durationMs)}ms` : "";
  return `${String(e.method).padEnd(6)} ${String(status).padEnd(6)} ${dur.padStart(7)}  ${e.url}`;
}

function fail(msg: string): void {
  console.error(msg);
  process.exit(1);
}
