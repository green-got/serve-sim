import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { simMiddleware } from "../middleware";

const DEVICE = "12345678-1234-1234-1234-123456789ABC";
const TOKEN = "screenshot-token";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const captured: string[] = [];
const middleware = simMiddleware({
  basePath: "/",
  device: DEVICE,
  execToken: TOKEN,
  captureScreenshot: async (device) => {
    captured.push(device);
    return PNG;
  },
});
const server = createHttpServer((req, res) => void middleware(req, res));
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/api/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
}

describe("browser screenshot download endpoint", () => {
  test("returns the selected simulator screenshot as a PNG attachment", async () => {
    captured.length = 0;
    const response = await request({ Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="serve-sim-screenshot-.+\.png"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(captured).toEqual([DEVICE]);
  });

  test("requires the preview token", async () => {
    captured.length = 0;
    const response = await request();
    expect(response.status).toBe(401);
    expect(captured).toEqual([]);
  });

  test("rejects cross-origin and non-JSON requests", async () => {
    const crossOrigin = await request({
      Authorization: `Bearer ${TOKEN}`,
      Origin: "https://attacker.example",
    });
    expect(crossOrigin.status).toBe(403);

    const text = await fetch(`${origin}/api/screenshot`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: "{}",
    });
    expect(text.status).toBe(415);
  });
});
