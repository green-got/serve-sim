- Test-driven development where possible.
- Prefer kebab-case for all TS/JS files.
- Avoid low-opacity for icons.

## The dev server reuses the production middleware

The preview client (`packages/serve-sim/src/client/`) is served two ways, but
they now share one transport and one route surface. Production wires
`simMiddleware` (`src/middleware.ts`) onto a Node `http` server via
`servePreview`; the live-reload dev server (`packages/serve-sim/dev.ts`) mounts
the **same** `simMiddleware` on its own Node `http` server and only intercepts
the handful of dev-only routes before delegating everything else to it.

This means **most host endpoints need no dev-side work at all** — add a route,
SSE channel, `ssePrefixes` entry, or `previewConfigForState` field to
`simMiddleware` and `bun run dev` picks it up automatically, because dev runs
that exact middleware. The control socket (`/exec-ws`) is likewise the
production `handleUpgrade`, attached to dev's `server.on("upgrade", …)`.

`dev.ts` overrides only what genuinely differs in dev:

- `GET /` — serves the freshly-bundled client HTML instead of the inlined build.
- `GET /__dev/reload` — browser auto-reload SSE.
- `POST /grid/api/start` — boots a helper from local source
  (`bun src/index.ts --detach`) rather than the published binary.
- It passes `serveSimBin: SERVE_SIM_BIN` to `simMiddleware` so the sidebar's
  `serve-sim …` CLI calls run from this checkout.

So the rule is simply: **build new host behavior in `simMiddleware`** (and its
shared helpers — `src/state.ts`, `src/network/routes.ts`, `src/exec-ws.ts`).
Only touch `dev.ts` when the behavior must differ in dev (local source, the live
HTML shell, or reload). Anything pulled into `dev.ts` that the production server
should also have is a red flag that it belongs in the middleware instead.

## E2E testing with agent-browser

The serve-sim web UI streams the iOS Simulator and forwards clicks, so end-to-end
behavior can be driven from a browser with the `agent-browser` CLI:

1. Build: `bun run packages/serve-sim/build.ts` (rebuilds the dylib + helper into
   `packages/serve-sim/dist/simcam/`).
2. Boot a simulator and start the server: `node packages/serve-sim/dist/serve-sim.js --port 3399`.
3. Drive the UI: `agent-browser open http://localhost:3399`, then `snapshot`,
   `click @eN`, `upload input[type=file] <path>`, `screenshot <path>`, etc.
4. Tap inside the simulator with `agent-browser mouse move <x> <y> && mouse down && mouse up`
   — the canvas isn't in the AX tree, so use pixel coordinates from a screenshot.

## E2E testing via the serve-sim CLI

For headless flows that don't need the browser, drive the simulator entirely
through `serve-sim` subcommands against a running server:

- `serve-sim tap <x> <y> [-d udid]` — single-shot tap at normalized (0..1)
  screen coords. Prefer this over `serve-sim gesture` for taps: each `gesture`
  call opens its own WebSocket, so two back-to-back `begin`/`end` invocations
  land far enough apart to register as a long-press.
- `serve-sim gesture '<json>' [-d udid]` — for drags or multi-step gestures
  that need explicit `begin`/`move`/`end` events.
- `serve-sim button [home|lock|…] [-d udid]` — hardware button.
- `serve-sim camera …` — inject the dylib, hot-swap source, toggle mirror.
- `serve-sim ui <option> [value] [-d udid]` — simulator-wide UI options
  (appearance, liquid-glass, color-filter, text-size, reduce-motion,
  increase-contrast, show-borders, reduce-transparency, voiceover); `ui status
  --json` dumps all. Verify sets via `simctl ui <udid> <option>` readback or
  `simctl spawn <udid> defaults read` on com.apple.Accessibility /
  com.apple.mediaaccessibility / com.apple.UIKit.
- `serve-sim network <start|stop|status|ls|tail|get <id>|export <har>|trust|untrust|clear>` —
  Proxyman-style HTTP(S) inspection. Talks to the running preview server
  (discovered via `$TMPDIR/serve-sim/preview.json`), so a `serve-sim` preview
  must be up. `start` runs a local MITM proxy, points the macOS system proxy at
  it, and trusts the serve-sim CA in the sim; HTTPS only decrypts after the app
  is relaunched. `stop` always restores the prior system proxy. `--decrypt
  a.com,b.com` limits TLS interception; `export out.har` writes HAR 1.2.
- `xcrun simctl openurl booted <url>` — deep-link into apps (faster than
  tapping through Expo Go's recent-projects list).

Typical camera e2e flow: rebuild, `camera --stop-webcam`, `simctl terminate`
the app, `camera <bundleId> --file <img> --mirror on` to re-inject, `openurl`
to load the project, `tap 0.5 0.9` for the shutter, then read the saved JPEG
off disk to verify (see the path under "agent-browser" above).