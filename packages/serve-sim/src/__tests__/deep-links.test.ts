import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { resolve } from "path";
import { parseDeepLinkManifest, readDeepLinkManifest } from "../deep-links";
import { simMiddleware } from "../middleware";
import { resolveDeepLink } from "../client/components/deep-links-panel";

const DEVICE = "12345678-1234-1234-1234-123456789ABC";
const TOKEN = "deep-link-token";
const opened: Array<{ device: string; url: string }> = [];
const middleware = simMiddleware({
  basePath: "/",
  device: DEVICE,
  execToken: TOKEN,
  openDeepLink: async (device, url) => { opened.push({ device, url }); },
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

describe("deep link manifests", () => {
  test("ships the complete manually exported Green-Got V2 route tree", () => {
    const manifest = readDeepLinkManifest(resolve(import.meta.dir, "../../manifests/green-got-v2.json"));
    expect(manifest.links).toHaveLength(56);
    expect(new Set(manifest.links.map((link) => link.url)).size).toBe(56);
    expect(manifest.links.some((link) => link.url === "green-got-staging://v2/onboarding")).toBe(true);
    const setup = manifest.links.find((link) => link.url.includes("/v2/custom-setup?"));
    expect(setup?.url).toContain("link={retail_api_url}");
    expect(setup?.url).toContain("next={next}");
    expect(setup?.parameters?.find(({ name }) => name === "next")?.default).toBe("/v2/onboarding");
  });

  test("validates inventory entries and resolves URL-encoded parameters", () => {
    const manifest = parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Cards",
        title: "Card details",
        url: "green-got-staging://v2/card/{id}",
      }],
    });
    expect(resolveDeepLink(manifest.links[0]!, { id: "card / 42" }))
      .toBe("green-got-staging://v2/card/card%20%2F%2042");
    expect(resolveDeepLink(manifest.links[0]!, {})).toBeNull();
  });

  test("uses parameter defaults and preserves human-readable field metadata", () => {
    const manifest = parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Debug",
        title: "Custom setup",
        url: "green-got-staging://v2/custom-setup?channel={channel}&mock={mock}&next={next}",
        parameters: [
          { name: "channel", label: "Expo channel", placeholder: "agent/my-branch" },
          { name: "mock", label: "Mock mode", default: "0" },
          { name: "next", label: "Open after setup", default: "/v2/onboarding" },
        ],
      }],
    });
    const link = manifest.links[0]!;
    expect(link.parameters?.[0]).toEqual({
      name: "channel",
      label: "Expo channel",
      placeholder: "agent/my-branch",
    });
    expect(resolveDeepLink(link, { channel: "agent/my branch" })).toBe(
      "green-got-staging://v2/custom-setup?channel=agent%2Fmy%20branch&mock=0&next=%2Fv2%2Fonboarding",
    );
  });

  test("rejects malformed, cross-scheme, and inconsistent manifest entries", () => {
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{ group: "Debug", title: "Bad", url: "/v2/onboarding" }],
    })).toThrow("URL must be absolute");
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{ group: "Debug", title: "Bad", url: "https://example.test/v2" }],
    })).toThrow("must use the green-got-staging scheme");
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Debug",
        title: "Bad",
        url: "green-got-staging://v2/{id}",
        parameters: [{ name: "missing" }],
      }],
    })).toThrow("parameter missing is not present");
  });
});

describe("deep link endpoint", () => {
  test("opens the URL on the selected simulator", async () => {
    opened.length = 0;
    const url = "green-got-staging://v2/onboarding";
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    expect(response.status).toBe(200);
    expect(opened).toEqual([{ device: DEVICE, url }]);
  });

  test("does not expose simulator control without the preview token", async () => {
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects cross-origin and non-JSON simulator control requests", async () => {
    const crossOrigin = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(crossOrigin.status).toBe(403);

    const text = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(text.status).toBe(415);
  });

  test("rejects malformed URLs before invoking simulator control", async () => {
    opened.length = 0;
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "/v2/onboarding" }),
    });
    expect(response.status).toBe(400);
    expect(opened).toEqual([]);
  });
});
