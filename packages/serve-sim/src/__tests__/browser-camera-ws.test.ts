import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3462;
const TOKEN = "browser-camera-token";
const DEVICE = "12345678-1234-1234-1234-123456789ABC";

let server: PreviewServer;
const packets: Buffer[] = [];

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: DEVICE,
    browserCameraPacketSink: async (_device, packet) => {
      expect(_device).toBe(DEVICE);
      packets.push(packet);
    },
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
});

function connect(token: string): Promise<{
  socket: WebSocket;
  ready: Promise<void>;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${PORT}/helper/${DEVICE}/camera/browser`,
    );
    let closeResolve: () => void;
    const closed = new Promise<void>((done) => { closeResolve = done; });
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((done, fail) => {
      readyResolve = done;
      readyReject = fail;
    });
    const timeout = setTimeout(() => reject(new Error("connect timeout")), 5_000);
    socket.onopen = () => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({ token }));
      resolve({ socket, ready, closed });
    };
    socket.onmessage = (event) => {
      const parse = async () => {
        const value = typeof event.data === "string"
          ? event.data
          : event.data instanceof Blob
            ? await event.data.text()
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const reply = JSON.parse(value) as { ready?: boolean; error?: string };
        if (reply.error) readyReject(new Error(reply.error));
        else if (reply.ready) readyResolve();
      };
      void parse();
    };
    socket.onerror = () => reject(new Error("socket error"));
    socket.onclose = () => closeResolve();
  });
}

describe("browser camera WebSocket", () => {
  test("authenticates and forwards H.264 configuration and frames to the selected device", async () => {
    packets.length = 0;
    const channel = await connect(TOKEN);
    await channel.ready;
    const config = Buffer.from([1, 1, 100, 0, 31]);
    const frame = Buffer.from([2, 1, 0, 0, 0, 1]);
    channel.socket.send(config);
    channel.socket.send(frame);

    const deadline = Date.now() + 2_000;
    while (packets.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(packets).toEqual([config, frame]);
    channel.socket.close();
  });

  test("rejects a bad token", async () => {
    const channel = await connect("wrong-token");
    await channel.closed;
  });
});
