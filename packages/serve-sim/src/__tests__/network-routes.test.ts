import { describe, expect, test } from "bun:test";
import {
  handleNetworkRoute,
  type NetworkRouteRequest,
  type NetworkRouteResult,
} from "../network/routes";

const TOKEN = "test-exec-token";
const CTX = { execToken: TOKEN, version: "0.0.0-test" };

function req(over: Partial<NetworkRouteRequest> = {}): NetworkRouteRequest {
  return {
    method: over.method ?? "GET",
    sub: over.sub ?? "status",
    params: over.params ?? new URLSearchParams(),
    host: over.host,
    origin: over.origin,
    contentType: over.contentType,
    authorization: over.authorization,
    selectedDevice: over.selectedDevice ?? null,
    readJson: over.readJson ?? (async () => ({})),
  };
}

describe("handleNetworkRoute", () => {
  test("read-only routes need no auth", async () => {
    const res = await handleNetworkRoute(req({ sub: "status", method: "GET" }), CTX);
    expect(res.kind).toBe("json");
    expect((res as Extract<NetworkRouteResult, { kind: "json" }>).status).toBe(200);
  });

  test("requests list returns exchanges + total", async () => {
    const res = await handleNetworkRoute(req({ sub: "requests", method: "GET" }), CTX);
    expect(res.kind).toBe("json");
    const body = (res as any).body;
    expect(Array.isArray(body.exchanges)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  test("har export is downloadable text", async () => {
    const res = await handleNetworkRoute(req({ sub: "har", method: "GET" }), CTX);
    expect(res.kind).toBe("text");
    expect(JSON.parse((res as any).body).log.version).toBe("1.2");
  });

  test("mutating route without JSON content-type → 415", async () => {
    const res = await handleNetworkRoute(req({ sub: "start", method: "POST" }), CTX);
    expect((res as any).status).toBe(415);
  });

  test("mutating route with wrong token → 401", async () => {
    const res = await handleNetworkRoute(
      req({ sub: "start", method: "POST", contentType: "application/json", authorization: "Bearer nope" }),
      CTX,
    );
    expect((res as any).status).toBe(401);
  });

  test("cross-origin mutating request → 403", async () => {
    const res = await handleNetworkRoute(
      req({
        sub: "start",
        method: "POST",
        contentType: "application/json",
        host: "localhost:3200",
        origin: "http://evil.example.com",
        authorization: `Bearer ${TOKEN}`,
      }),
      CTX,
    );
    expect((res as any).status).toBe(403);
  });

  test("DELETE requests is exempt from the JSON content-type check but still needs the token", async () => {
    const unauthed = await handleNetworkRoute(req({ sub: "requests", method: "DELETE" }), CTX);
    expect((unauthed as any).status).toBe(401);
    const authed = await handleNetworkRoute(
      req({ sub: "requests", method: "DELETE", authorization: `Bearer ${TOKEN}` }),
      CTX,
    );
    expect((authed as any).status).toBe(200);
  });

  test("events route yields an SSE subscription that tears down", async () => {
    const res = await handleNetworkRoute(req({ sub: "events", method: "GET" }), CTX);
    expect(res.kind).toBe("sse");
    const chunks: string[] = [];
    const teardown = (res as Extract<NetworkRouteResult, { kind: "sse" }>).subscribe((c) => chunks.push(c));
    expect(chunks[0]).toBe(":\n\n"); // initial comment flush
    teardown();
  });

  test("unknown route → 404", async () => {
    const res = await handleNetworkRoute(req({ sub: "bogus", method: "GET" }), CTX);
    expect((res as any).status).toBe(404);
  });
});
