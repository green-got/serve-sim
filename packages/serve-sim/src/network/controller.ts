/**
 * Network inspector controller — the single object the server routes and CLI
 * drive. Owns the capture store and ties together the MITM proxy, the macOS
 * system-proxy redirect, and per-simulator CA trust, exposing start/stop/status
 * plus HAR export over one lifecycle.
 *
 * A process-wide singleton (getNetworkInspector) keeps one proxy + one store
 * shared across every mounted middleware instance in the process.
 */
import { caPemPath, ensureCA } from "./ca";
import { NetworkProxy, DEFAULT_PROXY_PORT } from "./proxy";
import { NetworkStore } from "./store";
import { setSystemProxy, restoreSystemProxy, systemProxyState } from "./system-proxy";
import { installCA, uninstallCA } from "./trust";

export interface StartOptions {
  udid?: string;
  decryptHosts?: string[] | null;
  /** Skip touching the macOS system proxy (caller wires routing another way). */
  skipSystemProxy?: boolean;
}

export interface InspectorStatus {
  capturing: boolean;
  proxyPort: number;
  systemProxy: { active: boolean; services: string[] };
  trustedUdids: string[];
  caPath: string;
  exchangeCount: number;
  decryptHosts: string[] | null;
}

export class NetworkInspector {
  readonly store: NetworkStore;
  private readonly proxyPort: number;
  private proxy: NetworkProxy | null = null;
  private decryptHosts: string[] | null = null;
  private systemProxyServices: string[] = [];
  private readonly trustedUdids = new Set<string>();

  constructor(opts: { port?: number; version?: string } = {}) {
    this.proxyPort = opts.port ?? DEFAULT_PROXY_PORT;
    this.store = new NetworkStore({ version: opts.version });
  }

  get capturing(): boolean {
    return !!this.proxy;
  }

  /** Begin capture: trust the CA on the target sim, start the proxy, redirect. */
  async start(opts: StartOptions = {}): Promise<InspectorStatus> {
    ensureCA();
    if (opts.udid) this.trust(opts.udid);

    if (!this.proxy) {
      this.decryptHosts = opts.decryptHosts ?? null;
      this.proxy = new NetworkProxy({
        port: this.proxyPort,
        store: this.store,
        decryptHosts: this.decryptHosts,
      });
      await this.proxy.start();
    }

    if (!opts.skipSystemProxy) {
      this.systemProxyServices = setSystemProxy(this.proxyPort);
    }
    return this.status();
  }

  /** Stop capture: restore the system proxy and (optionally) reset sim trust. */
  async stop(opts: { uninstall?: boolean } = {}): Promise<InspectorStatus> {
    restoreSystemProxy();
    this.systemProxyServices = [];
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    if (opts.uninstall) {
      for (const udid of this.trustedUdids) uninstallCA(udid);
      this.trustedUdids.clear();
    }
    return this.status();
  }

  /** Install the CA into a simulator's trust store. */
  trust(udid: string): ReturnType<typeof installCA> {
    const res = installCA(udid);
    if (res.ok) this.trustedUdids.add(udid);
    return res;
  }

  untrust(udid: string): ReturnType<typeof uninstallCA> {
    const res = uninstallCA(udid);
    this.trustedUdids.delete(udid);
    return res;
  }

  status(): InspectorStatus {
    const sys = systemProxyState(this.proxyPort);
    return {
      capturing: this.capturing,
      proxyPort: this.proxyPort,
      systemProxy: { active: sys.active, services: sys.services },
      trustedUdids: [...this.trustedUdids],
      caPath: caPemPath(),
      exchangeCount: this.store.size,
      decryptHosts: this.decryptHosts,
    };
  }
}

let singleton: NetworkInspector | null = null;

/** Process-wide inspector shared across mounted middleware instances. */
export function getNetworkInspector(version?: string): NetworkInspector {
  if (!singleton) singleton = new NetworkInspector({ version });
  return singleton;
}
