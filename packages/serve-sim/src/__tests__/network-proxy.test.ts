import { afterAll, describe, expect, test } from "bun:test";
import http from "http";
import https from "https";
import zlib from "zlib";
import net from "net";
import { AddressInfo } from "net";
import forge from "node-forge";
import { NetworkStore } from "../network/store";
import { NetworkProxy } from "../network/proxy";
import { ensureCA, caPemPath } from "../network/ca";

const PROXY_PORT = 19271;

function makeSelfSignedTlsServer(handler: http.RequestListener) {
  // Origin's own cert; the proxy talks to it with rejectUnauthorized:false.
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return https.createServer(
    { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) },
    handler,
  );
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function httpThroughProxy(originPort: number, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        method: "GET",
        path: `http://127.0.0.1:${originPort}${path}`,
        headers: { Host: `127.0.0.1:${originPort}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// The MITM proxy is exercised through a CONNECT tunnel + TLS upgrade. Bun's
// `tls.connect({ socket })` over a bridged tunnel is unreliable, so the client
// runs in a Node subprocess (CFNetwork in the real simulator behaves like Node
// here). The proxy itself runs in this test process under Bun.
async function httpsThroughProxy(originPort: number, path: string): Promise<string> {
  const script = `
const net = require("net"), tls = require("tls");
const s = net.connect(${PROXY_PORT}, "127.0.0.1", () =>
  s.write("CONNECT localhost:${originPort} HTTP/1.1\\r\\nHost: localhost:${originPort}\\r\\n\\r\\n"));
s.once("data", (chunk) => {
  if (!/^HTTP\\/1\\.\\d 200/.test(chunk.toString())) { console.error("CONNECT failed"); process.exit(1); }
  const ca = require("fs").readFileSync(${JSON.stringify(caPemPath())}, "utf8");
  const t = tls.connect({ socket: s, servername: "localhost", ca }, () =>
    t.write("GET ${path} HTTP/1.1\\r\\nHost: localhost:${originPort}\\r\\nConnection: close\\r\\n\\r\\n"));
  let buf = ""; t.on("data", d => buf += d); t.on("end", () => { process.stdout.write(buf); process.exit(0); });
  t.on("error", (e) => { console.error(e.message); process.exit(1); });
});
s.on("error", (e) => { console.error(e.message); process.exit(1); });
`;
  const proc = Bun.spawn(["node", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("client failed: " + err);
  return out;
}

describe("NetworkProxy capture", () => {
  const store = new NetworkStore();
  let proxy: NetworkProxy;
  const servers: net.Server[] = [];

  afterAll(async () => {
    await proxy?.stop();
    for (const s of servers) s.close();
  });

  test("captures a plain HTTP request/response", async () => {
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("plain-ok");
    });
    servers.push(origin);
    const originPort = await listen(origin);

    proxy = new NetworkProxy({ port: PROXY_PORT, store });
    await proxy.start();

    await httpThroughProxy(originPort, "/hi");
    await Bun.sleep(50);

    const captured = store.list().find((e) => e.url.endsWith("/hi"));
    expect(captured).toBeDefined();
    expect(captured!.scheme).toBe("http");
    expect(captured!.status).toBe(200);
    expect(store.get(captured!.id)!.responseBody!.data!.toString()).toBe("plain-ok");
  });

  test("stop() resolves promptly even with a live keep-alive connection", async () => {
    const store2 = new NetworkStore();
    const origin = http.createServer((_req, res) => res.end("ok"));
    servers.push(origin);
    const originPort = await listen(origin);
    const p2 = new NetworkProxy({ port: 19272, store: store2 });
    await p2.start();

    // Open a keep-alive connection through the proxy and leave it open.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: 19272, method: "GET", path: `http://127.0.0.1:${originPort}/`, agent },
        (res) => { res.resume(); res.on("end", () => resolve()); },
      );
      req.on("error", reject);
      req.end();
    });

    const started = Date.now();
    await p2.stop();
    expect(Date.now() - started).toBeLessThan(2000); // would hang without force-close
    agent.destroy();
  });

  test("decrypts and captures an HTTPS request, decoding gzip", async () => {
    const origin = makeSelfSignedTlsServer((_req, res) => {
      const gz = zlib.gzipSync(Buffer.from('{"secret":"decrypted"}'));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
      res.end(gz);
    });
    servers.push(origin);
    const originPort = await listen(origin);

    ensureCA();
    const raw = await httpsThroughProxy(originPort, "/secure");
    expect(raw).toContain("200");
    await Bun.sleep(50);

    const captured = store.list().find((e) => e.url.includes("/secure"));
    expect(captured).toBeDefined();
    expect(captured!.scheme).toBe("https");
    // Stored body is decompressed plaintext.
    expect(store.get(captured!.id)!.responseBody!.data!.toString()).toBe('{"secret":"decrypted"}');
  });
});
