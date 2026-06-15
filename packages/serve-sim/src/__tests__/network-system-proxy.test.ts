import { describe, expect, test } from "bun:test";
import { parseServices, parseWebProxy, sanitizeBackupSetting } from "../network/system-proxy";

describe("parseServices", () => {
  test("drops the header line and disabled services", () => {
    const out = [
      "An asterisk (*) denotes that a network service is disabled.",
      "Wi-Fi",
      "Thunderbolt Bridge",
      "*Old VPN",
    ].join("\n");
    expect(parseServices(out)).toEqual(["Wi-Fi", "Thunderbolt Bridge"]);
  });

  test("handles trailing whitespace and blank lines", () => {
    const out = "Header\nWi-Fi \n\n Ethernet\n";
    expect(parseServices(out)).toEqual(["Wi-Fi", "Ethernet"]);
  });
});

describe("parseWebProxy", () => {
  test("parses an enabled proxy", () => {
    const out = ["Enabled: Yes", "Server: 127.0.0.1", "Port: 9270", "Authenticated Proxy Enabled: 0"].join("\n");
    expect(parseWebProxy(out)).toEqual({ enabled: true, server: "127.0.0.1", port: 9270 });
  });

  test("parses a disabled/empty proxy", () => {
    const out = ["Enabled: No", "Server:", "Port: 0", "Authenticated Proxy Enabled: 0"].join("\n");
    expect(parseWebProxy(out)).toEqual({ enabled: false, server: "", port: 0 });
  });
});

describe("sanitizeBackupSetting", () => {
  test("our own proxy is recorded as disabled (avoids restoring onto a dead proxy)", () => {
    expect(sanitizeBackupSetting({ enabled: true, server: "127.0.0.1", port: 9270 }, "127.0.0.1", 9270)).toEqual({
      enabled: false,
      server: "",
      port: 0,
    });
  });
  test("a genuine prior proxy is preserved", () => {
    const prior = { enabled: true, server: "10.0.0.1", port: 8888 };
    expect(sanitizeBackupSetting(prior, "127.0.0.1", 9270)).toEqual(prior);
  });
  test("a different local port is preserved", () => {
    const prior = { enabled: true, server: "127.0.0.1", port: 9090 };
    expect(sanitizeBackupSetting(prior, "127.0.0.1", 9270)).toEqual(prior);
  });
});
