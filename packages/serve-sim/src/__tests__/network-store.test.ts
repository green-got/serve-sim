import { describe, expect, test } from "bun:test";
import { NetworkStore, type NetworkExchange } from "../network/store";

function exchange(over: Partial<NetworkExchange> = {}): NetworkExchange {
  return {
    id: over.id ?? "x1",
    startedAt: over.startedAt ?? 1_700_000_000_000,
    durationMs: over.durationMs ?? 42,
    method: over.method ?? "GET",
    url: over.url ?? "https://example.com/api?q=1",
    host: over.host ?? "example.com",
    scheme: over.scheme ?? "https",
    status: over.status ?? 200,
    statusText: over.statusText ?? "OK",
    requestHeaders: over.requestHeaders ?? [{ name: "Accept", value: "*/*" }],
    responseHeaders: over.responseHeaders ?? [{ name: "Content-Type", value: "application/json" }],
    requestBody: over.requestBody,
    responseBody: over.responseBody,
    mimeType: over.mimeType ?? "application/json",
    bytesSent: over.bytesSent ?? 10,
    bytesReceived: over.bytesReceived ?? 20,
    error: over.error ?? null,
    ...over,
  };
}

function body(text: string) {
  const data = Buffer.from(text);
  return { data, size: data.length, truncated: false };
}

describe("NetworkStore", () => {
  test("records and lists newest-first", () => {
    const s = new NetworkStore();
    s.add(exchange({ id: "a", url: "https://a.com/" }));
    s.add(exchange({ id: "b", url: "https://b.com/" }));
    const list = s.list();
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
    expect(s.size).toBe(2);
  });

  test("list omits body bytes but reports sizes", () => {
    const s = new NetworkStore();
    s.add(exchange({ id: "a", responseBody: body("hello") }));
    const [summary] = s.list();
    expect(summary).not.toHaveProperty("responseBody");
    expect(summary!.responseBodySize).toBe(5);
    expect(summary!.hasResponseBody).toBe(true);
  });

  test("filter matches host or url substring", () => {
    const s = new NetworkStore();
    s.add(exchange({ id: "a", host: "api.example.com", url: "https://api.example.com/v1" }));
    s.add(exchange({ id: "b", host: "cdn.other.net", url: "https://cdn.other.net/img" }));
    expect(s.list({ filter: "example" }).map((e) => e.id)).toEqual(["a"]);
    expect(s.list({ filter: "img" }).map((e) => e.id)).toEqual(["b"]);
  });

  test("cap evicts oldest records", () => {
    const s = new NetworkStore({ cap: 2 });
    s.add(exchange({ id: "a" }));
    s.add(exchange({ id: "b" }));
    s.add(exchange({ id: "c" }));
    expect(s.list().map((e) => e.id)).toEqual(["c", "b"]);
    expect(s.size).toBe(2);
  });

  test("body budget evicts oldest body bytes but keeps metadata", () => {
    const s = new NetworkStore({ bodyBudgetBytes: 8 });
    s.add(exchange({ id: "a", responseBody: body("12345") })); // 5 bytes
    s.add(exchange({ id: "b", responseBody: body("67890") })); // +5 => over 8
    // Oldest body dropped, but the record is still listed.
    expect(s.size).toBe(2);
    expect(s.body("a", "response")!.data).toBeNull();
    expect(s.body("a", "response")!.size).toBe(5); // size preserved
    expect(s.body("b", "response")!.data).not.toBeNull();
  });

  test("emits exchange event on add", () => {
    const s = new NetworkStore();
    let seen: string | undefined;
    s.on("exchange", (e) => (seen = e.id));
    s.add(exchange({ id: "evt" }));
    expect(seen).toBe("evt");
  });

  test("get returns full record incl. bodies", () => {
    const s = new NetworkStore();
    s.add(exchange({ id: "a", requestBody: body("payload") }));
    expect(s.get("a")!.requestBody!.data!.toString()).toBe("payload");
    expect(s.get("missing")).toBeUndefined();
  });

  test("toHar produces valid HAR 1.2 with entries", () => {
    const s = new NetworkStore({ version: "1.2.3" });
    s.add(
      exchange({
        id: "a",
        method: "POST",
        url: "https://example.com/api?q=1&r=2",
        status: 201,
        responseBody: body('{"ok":true}'),
      }),
    );
    const har = s.toHar() as any;
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator).toEqual({ name: "serve-sim", version: "1.2.3" });
    expect(har.log.entries).toHaveLength(1);
    const entry = har.log.entries[0];
    expect(entry.request.method).toBe("POST");
    expect(entry.request.queryString).toEqual([
      { name: "q", value: "1" },
      { name: "r", value: "2" },
    ]);
    expect(entry.response.status).toBe(201);
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("clear empties the buffer", () => {
    const s = new NetworkStore();
    s.add(exchange({ id: "a" }));
    s.clear();
    expect(s.size).toBe(0);
    expect(s.list()).toEqual([]);
  });
});
