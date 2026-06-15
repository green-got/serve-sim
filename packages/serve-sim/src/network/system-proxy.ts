/**
 * macOS system HTTP/HTTPS proxy control for the network inspector.
 *
 * The iOS Simulator is not a VM — its apps inherit the Mac's system proxy via
 * CFNetwork. Pointing the system proxy at our MITM proxy is therefore what
 * routes simulator traffic through it (the same trick other proxy tools use). We
 * snapshot the prior per-service settings before changing them and always
 * restore on stop and on process exit, so we never strand the Mac proxied.
 *
 * Pure parsers (parseServices/parseWebProxy) are split out for unit testing;
 * the apply/restore paths shell out to `networksetup`.
 */
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { debugNet } from "../debug";

const STATE_DIR = join(tmpdir(), "serve-sim");
const BACKUP_PATH = join(STATE_DIR, "network", "system-proxy-backup.json");

export interface ProxySetting {
  enabled: boolean;
  server: string;
  port: number;
}

interface ServiceBackup {
  service: string;
  web: ProxySetting;
  secure: ProxySetting;
}

export interface SystemProxyState {
  /** True when at least one active service points at the given port. */
  active: boolean;
  port: number | null;
  services: string[];
}

/** Parse `networksetup -listallnetworkservices`. Skips the header + disabled (*) ones. */
export function parseServices(output: string): string[] {
  return output
    .split("\n")
    .slice(1) // first line is an informational header
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("*")); // "*" marks a disabled service
}

/** Parse `networksetup -getwebproxy <service>` into a ProxySetting. */
export function parseWebProxy(output: string): ProxySetting {
  const get = (key: string) => output.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";
  return {
    enabled: /^yes$/i.test(get("Enabled")),
    server: get("Server"),
    port: Number(get("Port")) || 0,
  };
}

function networksetup(args: string[]): string {
  return execFileSync("networksetup", args, { encoding: "utf8" });
}

function activeServices(): string[] {
  try {
    return parseServices(networksetup(["-listallnetworkservices"]));
  } catch (err) {
    debugNet("activeServices: networksetup -listallnetworkservices failed: %o", err);
    return [];
  }
}

function readSetting(flag: "-getwebproxy" | "-getsecurewebproxy", service: string): ProxySetting {
  try {
    return parseWebProxy(networksetup([flag, service]));
  } catch (err) {
    debugNet("readSetting %s for %s failed: %o", flag, service, err);
    return { enabled: false, server: "", port: 0 };
  }
}

/**
 * Snapshot every active service's current web + secure proxy, then point them
 * all at 127.0.0.1:<port>. Returns the services that were changed.
 */
/**
 * If a service already points at our own proxy (e.g. a prior capture's stop was
 * interrupted), don't snapshot that as the state to restore — restoring it would
 * strand the Mac on a dead proxy. Record it as disabled instead.
 */
export function sanitizeBackupSetting(s: ProxySetting, host: string, port: number): ProxySetting {
  return s.server === host && s.port === port ? { enabled: false, server: "", port: 0 } : s;
}

export function setSystemProxy(port: number, host = "127.0.0.1"): string[] {
  const services = activeServices();
  const backup: ServiceBackup[] = services.map((service) => ({
    service,
    web: sanitizeBackupSetting(readSetting("-getwebproxy", service), host, port),
    secure: sanitizeBackupSetting(readSetting("-getsecurewebproxy", service), host, port),
  }));

  mkdirSync(join(STATE_DIR, "network"), { recursive: true });
  // Don't clobber an existing backup (e.g. two servers both enabling capture):
  // the first snapshot is the real pre-capture state.
  if (!existsSync(BACKUP_PATH)) {
    writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));
  }

  const changed: string[] = [];
  for (const service of services) {
    try {
      networksetup(["-setwebproxy", service, host, String(port)]);
      networksetup(["-setsecurewebproxy", service, host, String(port)]);
      changed.push(service);
    } catch (err) {
      /* service may be read-only / inactive; skip it */
      debugNet("setSystemProxy: failed to point %s at %s:%d: %o", service, host, port, err);
    }
  }
  registerRestoreGuard();
  return changed;
}

/** Restore the snapshotted proxy settings and delete the backup. */
export function restoreSystemProxy(): void {
  if (!existsSync(BACKUP_PATH)) return;
  let backup: ServiceBackup[];
  try {
    backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
  } catch (err) {
    debugNet("restoreSystemProxy: unreadable backup %s, discarding: %o", BACKUP_PATH, err);
    rmSync(BACKUP_PATH, { force: true });
    return;
  }
  for (const { service, web, secure } of backup) {
    applySetting("-setwebproxy", "-setwebproxystate", service, web);
    applySetting("-setsecurewebproxy", "-setsecurewebproxystate", service, secure);
  }
  rmSync(BACKUP_PATH, { force: true });
}

function applySetting(
  setFlag: "-setwebproxy" | "-setsecurewebproxy",
  stateFlag: "-setwebproxystate" | "-setsecurewebproxystate",
  service: string,
  prior: ProxySetting,
): void {
  try {
    if (prior.server && prior.port) {
      networksetup([setFlag, service, prior.server, String(prior.port)]);
    }
    networksetup([stateFlag, service, prior.enabled ? "on" : "off"]);
  } catch (err) {
    /* best-effort restore */
    debugNet("applySetting %s for %s failed: %o", setFlag, service, err);
  }
}

/** Current state: are active services pointed at `port`? */
export function systemProxyState(port: number): SystemProxyState {
  const services = activeServices();
  const matching = services.filter((s) => {
    const web = readSetting("-getwebproxy", s);
    return web.enabled && web.server === "127.0.0.1" && web.port === port;
  });
  return { active: matching.length > 0, port: matching.length > 0 ? port : null, services: matching };
}

let guardRegistered = false;
function registerRestoreGuard(): void {
  if (guardRegistered) return;
  guardRegistered = true;
  const restore = () => {
    try {
      restoreSystemProxy();
    } catch (err) {
      /* nothing more we can do on the way out */
      debugNet("restore guard: restoreSystemProxy failed on exit: %o", err);
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}
