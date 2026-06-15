import { describe, expect, test, beforeAll } from "bun:test";
import { X509Certificate } from "crypto";
import forge from "node-forge";
import { ensureCA, leafCertForHost, caPemPath } from "../network/ca";

describe("network CA", () => {
  beforeAll(() => {
    // Exercise the on-disk cache path; CA persists under STATE_DIR/network.
    ensureCA();
  });

  test("ensureCA is a self-signed CA cert", () => {
    const ca = ensureCA();
    const x = new X509Certificate(ca.certPem);
    expect(x.ca).toBe(true);
    expect(x.subject).toContain("serve-sim");
    // Self-signed: subject === issuer.
    expect(x.subject).toBe(x.issuer);
  });

  test("ensureCA is stable across calls (cached)", () => {
    expect(ensureCA().certPem).toBe(ensureCA().certPem);
  });

  test("caPemPath points at the cert on disk", () => {
    expect(caPemPath()).toMatch(/serve-sim-ca\.pem$/);
  });

  test("leaf cert is signed by the CA and matches the host", () => {
    const ca = ensureCA();
    const leaf = leafCertForHost("api.example.com");
    const leafCert = forge.pki.certificateFromPem(leaf.cert);

    // Issued by the CA (verify signature with CA public key).
    expect(ca.cert.verify(leafCert)).toBe(true);

    const cn = leafCert.subject.getField("CN");
    expect(cn.value).toBe("api.example.com");

    const san = leafCert.getExtension("subjectAltName") as any;
    const dnsNames = san.altNames.map((a: any) => a.value);
    expect(dnsNames).toContain("api.example.com");
    expect(dnsNames).toContain("*.example.com");
  });

  test("leaf certs are cached per host", () => {
    expect(leafCertForHost("cached.example.com").cert).toBe(
      leafCertForHost("cached.example.com").cert,
    );
  });

  test("IP hosts get an IP SAN, not a wildcard", () => {
    const leaf = leafCertForHost("127.0.0.1");
    const leafCert = forge.pki.certificateFromPem(leaf.cert);
    const san = leafCert.getExtension("subjectAltName") as any;
    expect(san.altNames.some((a: any) => a.ip === "127.0.0.1")).toBe(true);
  });
});
