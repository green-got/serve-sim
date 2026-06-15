import { tmpdir } from "os";
import { join } from "path";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { debugState } from "./debug";

/** Directory where serve-sim stores runtime state. */
export const STATE_DIR = join(tmpdir(), "serve-sim");

/** Path to the serve-sim server state file (JSON with pid, port, URLs).
 *  @deprecated Use `stateFileForDevice(udid)` for multi-device support. Kept for backward compat. */
export const STATE_FILE = join(STATE_DIR, "server.json");

/** Per-device state file: `/tmp/serve-sim/server-{udid}.json` */
export function stateFileForDevice(udid: string): string {
  return join(STATE_DIR, `server-${udid}.json`);
}

/** List all per-device state files in the state directory. */
export function listStateFiles(): string[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith("server-") && f.endsWith(".json"))
      .map((f) => join(STATE_DIR, f));
  } catch {
    return [];
  }
}

/** Runtime descriptor a serve-sim helper writes to its per-device state file. */
export interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

type SimctlBootedList = {
  devices: Record<string, Array<{ udid: string; state: string }>>;
};

// Cache simctl's booted-device set briefly. Both servers call
// readServeSimStates() on every request, so uncached we'd shell out to simctl
// per page view / per SSE channel.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };

/** Drop the booted-device cache so the next read re-queries simctl. */
export function invalidateBootedSnapshot(): void {
  bootedSnapshot = { at: 0, booted: null };
}

/** Set of currently-booted simulator UDIDs (1.5s cached), or null on failure. */
export function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as SimctlBootedList;
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    return null;
  }
}

/**
 * Read every live serve-sim helper's state. Prunes state files whose helper
 * process is gone, and recycles (SIGTERM + unlink) helpers whose backing
 * simulator is no longer booted — those keep their MJPEG socket open but never
 * produce frames, so the preview would hang on "Connecting…".
 */
export function readServeSimStates(): ServeSimState[] {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = getBootedUdids();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const state: ServeSimState = JSON.parse(readFileSync(path, "utf-8"));
      try {
        process.kill(state.pid, 0);
      } catch {
        debugState("helper pid=%d gone, removing %s", state.pid, path);
        try { unlinkSync(path); } catch {}
        continue;
      }
      if (booted && !booted.has(state.device)) {
        debugState(
          "recycling stale helper pid=%d (device %s no longer booted)",
          state.pid,
          state.device,
        );
        try { process.kill(state.pid, "SIGTERM"); } catch {}
        try { unlinkSync(path); } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

/** Pick the helper for `device`, or the first available when unspecified. */
export function selectServeSimState(
  states: ServeSimState[],
  device?: string | null,
): ServeSimState | null {
  if (device) return states.find((state) => state.device === device) ?? null;
  return states[0] ?? null;
}
