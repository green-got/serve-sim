/**
 * Install / remove the serve-sim CA in a simulator's trust store.
 *
 * `simctl keychain <udid> add-root-cert` adds our CA as a trusted root so the
 * leaf certs the proxy mints validate inside the sim. Mirrors the simctl
 * shell-out style used elsewhere (e.g. `simctl privacy`, `simctl ui`). The app
 * under test must be relaunched (or the sim reset) to pick up a freshly added
 * root.
 */
import { execFileSync } from "child_process";
import { caPemPath, ensureCA } from "./ca";

export interface TrustResult {
  udid: string;
  ok: boolean;
  error?: string;
}

/** Add the serve-sim CA to `udid`'s trust store. */
export function installCA(udid: string): TrustResult {
  ensureCA();
  try {
    execFileSync("xcrun", ["simctl", "keychain", udid, "add-root-cert", caPemPath()], {
      stdio: "pipe",
    });
    return { udid, ok: true };
  } catch (err: any) {
    return { udid, ok: false, error: err?.stderr?.toString?.() ?? err?.message ?? String(err) };
  }
}

/**
 * Remove the serve-sim CA from `udid`. simctl has no single-cert removal, so
 * this resets the simulator keychain (clears all certs added via simctl).
 */
export function uninstallCA(udid: string): TrustResult {
  try {
    execFileSync("xcrun", ["simctl", "keychain", udid, "reset"], { stdio: "pipe" });
    return { udid, ok: true };
  } catch (err: any) {
    return { udid, ok: false, error: err?.stderr?.toString?.() ?? err?.message ?? String(err) };
  }
}
