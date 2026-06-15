/**
 * Root CA + per-host leaf certificates for TLS interception.
 *
 * A single serve-sim root CA is generated once and cached on disk under
 * `STATE_DIR/network`. The same CA is installed into each simulator's trust
 * store (see trust.ts) so the simulator accepts the leaf certs we mint on the
 * fly for every intercepted HTTPS host. Leaf certs are cached in-process keyed
 * by host. Uses node-forge for X.509 generation (kept external in build.ts).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import forge from "node-forge";

const STATE_DIR = join(tmpdir(), "serve-sim");
const CA_DIR = join(STATE_DIR, "network");
const CA_CERT_PATH = join(CA_DIR, "serve-sim-ca.pem");
const CA_KEY_PATH = join(CA_DIR, "serve-sim-ca.key");

export interface CA {
  certPem: string;
  keyPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.PrivateKey;
}

export interface LeafCert {
  cert: string; // PEM
  key: string; // PEM
}

let cachedCA: CA | null = null;
const leafCache = new Map<string, LeafCert>();

/** Absolute path to the CA certificate PEM (generating it if needed). */
export function caPemPath(): string {
  ensureCA();
  return CA_CERT_PATH;
}

/** Load the cached CA from disk, or generate + persist a new one. */
export function ensureCA(): CA {
  if (cachedCA) return cachedCA;

  if (existsSync(CA_CERT_PATH) && existsSync(CA_KEY_PATH)) {
    const certPem = readFileSync(CA_CERT_PATH, "utf8");
    const keyPem = readFileSync(CA_KEY_PATH, "utf8");
    cachedCA = {
      certPem,
      keyPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
    };
    return cachedCA;
  }

  cachedCA = generateCA();
  mkdirSync(CA_DIR, { recursive: true });
  writeFileSync(CA_CERT_PATH, cachedCA.certPem, { mode: 0o644 });
  writeFileSync(CA_KEY_PATH, cachedCA.keyPem, { mode: 0o600 });
  return cachedCA;
}

function generateCA(): CA {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "serve-sim Network Inspector CA" },
    { name: "organizationName", value: "serve-sim" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    cert,
    key: keys.privateKey,
  };
}

/**
 * Mint (or return a cached) leaf certificate for `host`, signed by the CA.
 * Covers the exact host plus a wildcard sibling so `api.x.com` and `*.x.com`
 * both validate against one cert.
 */
export function leafCertForHost(host: string): LeafCert {
  const cached = leafCache.get(host);
  if (cached) return cached;

  const ca = ensureCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(ca.cert.subject.attributes);

  const altNames = subjectAltNames(host);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  cert.sign(ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  const leaf: LeafCert = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  leafCache.set(host, leaf);
  return leaf;
}

/** SAN entries: the host itself (IP or DNS) plus a one-level wildcard parent. */
function subjectAltNames(host: string): Array<{ type: number; value?: string; ip?: string }> {
  // type 7 = IP address, type 2 = DNS name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return [{ type: 7, ip: host }];
  }
  const names = new Set<string>([host]);
  const parts = host.split(".");
  if (parts.length > 2) names.add("*." + parts.slice(1).join("."));
  return [...names].map((value) => ({ type: 2, value }));
}

function randomSerial(): string {
  // Positive hex serial; forge wants a hex string with a leading non-FF byte.
  const bytes = forge.random.getBytesSync(16);
  let hex = forge.util.bytesToHex(bytes);
  // Ensure positive (high bit clear) so some validators don't reject it.
  const first = parseInt(hex.slice(0, 2), 16) & 0x7f;
  hex = first.toString(16).padStart(2, "0") + hex.slice(2);
  return hex;
}

/** Test seam: drop in-memory caches so a fresh CA/leafs are produced. */
export function _resetCachesForTest(): void {
  cachedCA = null;
  leafCache.clear();
}
