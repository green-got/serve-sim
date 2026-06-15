import { describe, expect, test } from "bun:test";
import {
  parseJsonLine,
  prependExchange,
  filterRows,
  statusBadge,
  formatBytes,
  parseQueryParams,
  classifyBody,
  prettyJson,
  buildCurl,
  decodeBase64Utf8,
  pathOf,
  looksBinary,
  renderBody,
  isPreviewableBody,
  bodyMeta,
  PREVIEW_FETCH_LIMIT,
  type ExchangeRow,
} from "../client/components/network-inspector-tool";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
function b64bytes(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function row(over: Partial<ExchangeRow> = {}): ExchangeRow {
  return {
    id: over.id ?? "1",
    method: over.method ?? "GET",
    url: over.url ?? "https://api.example.com/v1/things?x=1",
    host: over.host ?? "api.example.com",
    scheme: over.scheme ?? "https",
    status: over.status ?? 200,
    durationMs: over.durationMs ?? 12,
    ...over,
  };
}

describe("parseJsonLine", () => {
  test("parses a clean JSON object", () => {
    expect(parseJsonLine<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  test("recovers JSON from a trailing line after noise", () => {
    expect(parseJsonLine<{ ok: boolean }>('hint text\n{"ok":true}')).toEqual({ ok: true });
  });
  test("returns null for non-JSON", () => {
    expect(parseJsonLine("not json")).toBeNull();
    expect(parseJsonLine("")).toBeNull();
  });
});

describe("prependExchange", () => {
  test("prepends newest first", () => {
    const out = prependExchange([row({ id: "a" })], row({ id: "b" }));
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });
  test("dedupes by id", () => {
    const list = [row({ id: "a" })];
    expect(prependExchange(list, row({ id: "a" }))).toBe(list);
  });
  test("caps the list", () => {
    const out = prependExchange([row({ id: "a" }), row({ id: "b" })], row({ id: "c" }), 2);
    expect(out.map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("filterRows", () => {
  const rows = [
    row({ id: "1", host: "api.example.com", url: "https://api.example.com/v1", method: "GET" }),
    row({ id: "2", host: "cdn.other.net", url: "https://cdn.other.net/img.png", method: "POST" }),
  ];
  test("matches host", () => {
    expect(filterRows(rows, "example").map((r) => r.id)).toEqual(["1"]);
  });
  test("matches method", () => {
    expect(filterRows(rows, "post").map((r) => r.id)).toEqual(["2"]);
  });
  test("empty filter returns all", () => {
    expect(filterRows(rows, "  ")).toHaveLength(2);
  });
});

describe("statusBadge", () => {
  test("2xx is ok", () => expect(statusBadge(row({ status: 200 })).tone).toBe("ok"));
  test("4xx is warn", () => expect(statusBadge(row({ status: 404 })).tone).toBe("warn"));
  test("5xx is err", () => expect(statusBadge(row({ status: 503 })).tone).toBe("err"));
  test("error is err", () => expect(statusBadge(row({ status: null, error: "boom" })).tone).toBe("err"));
  test("tunnel-only is muted", () => {
    expect(statusBadge(row({ tlsTunnelOnly: true, status: null })).label).toBe("TLS");
  });
});

describe("formatBytes", () => {
  test("scales B/KB/MB", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("parseQueryParams", () => {
  test("extracts params", () => {
    expect(parseQueryParams("https://x.com/a?q=1&r=two")).toEqual([
      { name: "q", value: "1" },
      { name: "r", value: "two" },
    ]);
  });
  test("no query → empty", () => expect(parseQueryParams("https://x.com/a")).toEqual([]));
});

describe("pathOf", () => {
  test("returns path + search", () => expect(pathOf("https://x.com/a/b?z=1")).toBe("/a/b?z=1"));
  test("root path", () => expect(pathOf("https://x.com")).toBe("/"));
});

describe("classifyBody", () => {
  test("json", () => expect(classifyBody("application/json; charset=utf-8")).toBe("json"));
  test("image", () => expect(classifyBody("image/png")).toBe("image"));
  test("html is text", () => expect(classifyBody("text/html")).toBe("text"));
  test("form", () => expect(classifyBody("application/x-www-form-urlencoded")).toBe("form"));
  test("octet-stream is binary", () => expect(classifyBody("application/octet-stream")).toBe("binary"));
  test("missing defaults to text", () => expect(classifyBody(undefined)).toBe("text"));
});

describe("prettyJson", () => {
  test("pretty-prints valid json", () => expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}'));
  test("passes through invalid json", () => expect(prettyJson("not json")).toBe("not json"));
});

describe("decodeBase64Utf8", () => {
  test("round-trips utf-8", () => {
    const b64 = Buffer.from("héllo →", "utf8").toString("base64");
    expect(decodeBase64Utf8(b64)).toBe("héllo →");
  });
});

describe("looksBinary", () => {
  test("flags NUL bytes", () => expect(looksBinary("ab\u0000cd")).toBe(true));
  test("flags heavy replacement chars", () => expect(looksBinary("�".repeat(10))).toBe(true));
  test("plain text is not binary", () => expect(looksBinary('{"a":1}')).toBe(false));
});

describe("renderBody", () => {
  test("null when no payload", () => expect(renderBody(null, "json", "application/json")).toBeNull());
  test("json is decoded + pretty-printed text", () => {
    const r = renderBody({ size: 7, truncated: false, base64: b64('{"a":1}') }, "json", "application/json");
    expect(r).toEqual({ text: '{\n  "a": 1\n}' });
  });
  test("image returns a data URL", () => {
    const r = renderBody({ size: 3, truncated: false, base64: b64("xyz") }, "image", "image/png") as any;
    expect(r.image).toBe(`data:image/png;base64,${b64("xyz")}`);
  });
  test("octet-stream content-type renders as binary, not text", () => {
    const r = renderBody({ size: 4, truncated: true, base64: b64bytes([0, 159, 146, 150]) }, "binary", "application/octet-stream");
    expect(r).toEqual({ binary: true });
  });
  test("text that decodes to binary (NUL) falls back to binary", () => {
    const r = renderBody({ size: 4, truncated: false, base64: b64bytes([65, 0, 66, 0]) }, "text", "text/plain");
    expect(r).toEqual({ binary: true });
  });
});

describe("isPreviewableBody", () => {
  test("binary is never previewable", () => expect(isPreviewableBody("binary", 100)).toBe(false));
  test("small text/json/image previewable", () => {
    expect(isPreviewableBody("json", 1024)).toBe(true);
    expect(isPreviewableBody("image", 1024)).toBe(true);
  });
  test("oversized is not previewable", () => {
    expect(isPreviewableBody("json", PREVIEW_FETCH_LIMIT + 1)).toBe(false);
  });
});

describe("bodyMeta", () => {
  test("response uses mimeType + responseBodySize", () => {
    const m = bodyMeta(
      row({ mimeType: "application/json", responseBodySize: 42, hasResponseBody: true }),
      "response",
    );
    expect(m).toEqual({ hasBody: true, size: 42, contentType: "application/json", kind: "json" });
  });
  test("huge octet-stream response is binary + not previewable", () => {
    const m = bodyMeta(
      row({ mimeType: "binary/octet-stream", responseBodySize: 624 * 1024 * 1024, hasResponseBody: true }),
      "response",
    );
    expect(m.kind).toBe("binary");
    expect(isPreviewableBody(m.kind, m.size)).toBe(false);
  });
  test("request reads request headers + size", () => {
    const m = bodyMeta(
      row({ requestHeaders: [{ name: "Content-Type", value: "text/plain" }], requestBodySize: 5, hasRequestBody: true }),
      "request",
    );
    expect(m).toEqual({ hasBody: true, size: 5, contentType: "text/plain", kind: "text" });
  });
});

describe("buildCurl", () => {
  test("emits method, url, headers, body; drops host/content-length", () => {
    const curl = buildCurl(
      row({
        method: "POST",
        url: "https://api.example.com/v1?x=1",
        requestHeaders: [
          { name: "Host", value: "api.example.com" },
          { name: "Authorization", value: "Bearer t" },
          { name: "Content-Length", value: "9" },
        ],
      }),
      '{"a":1}',
    );
    expect(curl).toContain("curl -X POST 'https://api.example.com/v1?x=1'");
    expect(curl).toContain("-H 'Authorization: Bearer t'");
    expect(curl).not.toContain("Host:");
    expect(curl).not.toContain("Content-Length");
    expect(curl).toContain(`--data-raw '{"a":1}'`);
  });
  test("escapes single quotes in body", () => {
    const curl = buildCurl(row({ requestHeaders: [] }), "it's");
    expect(curl).toContain(`--data-raw 'it'\\''s'`);
  });
});
