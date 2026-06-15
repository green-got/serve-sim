import { describe, expect, test } from "bun:test";
import { parseNetworkArgs } from "../network/cli";

describe("parseNetworkArgs", () => {
  test("no args defaults to status", () => {
    expect(parseNetworkArgs([])).toEqual({ command: "status", json: false, uninstall: false });
  });

  test("start with device and decrypt list", () => {
    expect(parseNetworkArgs(["start", "-d", "ABC", "--decrypt", "a.com, b.com"])).toEqual({
      command: "start",
      device: "ABC",
      decrypt: ["a.com", "b.com"],
      json: false,
      uninstall: false,
    });
  });

  test("stop with --uninstall", () => {
    expect(parseNetworkArgs(["stop", "--uninstall"])).toMatchObject({
      command: "stop",
      uninstall: true,
    });
  });

  test("export captures the file positional", () => {
    expect(parseNetworkArgs(["export", "/tmp/out.har"])).toMatchObject({
      command: "export",
      file: "/tmp/out.har",
    });
  });

  test("ls with --json", () => {
    expect(parseNetworkArgs(["ls", "--json"])).toMatchObject({ command: "ls", json: true });
  });

  test("unknown command throws", () => {
    expect(() => parseNetworkArgs(["bogus"])).toThrow(/Unknown network command/);
  });
});
