import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startSystemProxyRelay } from "./system-proxy-relay.js";
import {
  activeNodeTransportRoute,
  applyNodeNetworkProxy,
} from "./node-proxy.js";
import { connectTcp, SocketReader } from "./socks5.js";

type TestServer = Server | ReturnType<typeof createHttpServer>;

async function listen(server: TestServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return address.port;
}

async function close(server: TestServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function authenticatedSocksConnect(
  relayUrl: string,
  host: string,
  port: number,
  password = new URL(relayUrl).password,
): Promise<{ socket: Socket; reader: SocketReader; authReply: Buffer }> {
  const relay = new URL(relayUrl);
  const socket = await connectTcp(relay.hostname, Number(relay.port));
  const reader = new SocketReader(socket);
  const username = Buffer.from(decodeURIComponent(relay.username), "utf8");
  const passwordBytes = Buffer.from(password, "utf8");

  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  expect(await reader.readExact(2)).toEqual(Buffer.from([0x05, 0x02]));
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([passwordBytes.length]),
      passwordBytes,
    ]),
  );
  const authReply = await reader.readExact(2);
  if (authReply[1] !== 0x00) return { socket, reader, authReply };

  const destination = new URL(`http://${host}:${port}`);
  const address = Buffer.from(destination.hostname.split(".").map(Number));
  const destinationPort = Buffer.alloc(2);
  destinationPort.writeUInt16BE(port, 0);
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x01]),
      address,
      destinationPort,
    ]),
  );
  const connectReply = await reader.readExact(4);
  if (connectReply[3] !== 0x01) throw new Error("unexpected SOCKS5 bind type");
  await reader.readExact(6);
  return { socket, reader, authReply };
}

describe("System proxy relay", () => {
  afterEach(() => {
    applyNodeNetworkProxy({ mode: "direct" });
  });

  it("routes provider HTTP through the resolved proxy and keeps the scheme on non-default ports", async () => {
    let resolvedUrl = "";
    let proxyRequestUrl = "";
    const proxy = createHttpServer((request, response) => {
      proxyRequestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("system proxy response");
    });
    const proxyPort = await listen(proxy);
    const unavailablePort = await closedPort();
    const relay = await startSystemProxyRelay(async (url) => {
      resolvedUrl = url;
      return `PROXY 127.0.0.1:${unavailablePort}; PROXY 127.0.0.1:${proxyPort}`;
    });

    try {
      applyNodeNetworkProxy({ mode: "system" }, process.env, relay.url);
      expect(activeNodeTransportRoute()).toBe("system-proxy");

      const response = await fetch("http://model.invalid:8127/v1/chat/completions", {
        signal: AbortSignal.timeout(3_000),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("system proxy response");
      expect(resolvedUrl).toBe("http://model.invalid:8127/");
      expect(proxyRequestUrl).toBe("http://model.invalid:8127/v1/chat/completions");
    } finally {
      await relay.close();
      await close(proxy);
    }
  });

  it("rejects clients without the relay credential before proxy resolution", async () => {
    let resolveCalls = 0;
    const relay = await startSystemProxyRelay(async () => {
      resolveCalls += 1;
      return "DIRECT";
    });

    try {
      const { socket, reader, authReply } = await authenticatedSocksConnect(
        relay.url,
        "127.0.0.1",
        443,
        "incorrect-credential",
      );
      try {
        expect(authReply).toEqual(Buffer.from([0x01, 0x01]));
        expect(resolveCalls).toBe(0);
      } finally {
        reader.dispose();
        socket.destroy();
      }
    } finally {
      await relay.close();
    }
  });

  it("resolves HTTPS from the TLS handshake on a non-default port and forwards its bytes", async () => {
    let resolvedUrl = "";
    let received = Buffer.alloc(0);
    let resolveReceived: (() => void) | null = null;
    const receivedBytes = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const target = createServer((socket) => {
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 7) resolveReceived?.();
      });
    });
    const targetPort = await listen(target);
    const relay = await startSystemProxyRelay(async (url) => {
      resolvedUrl = url;
      return "DIRECT";
    });

    try {
      const { socket, reader } = await authenticatedSocksConnect(
        relay.url,
        "127.0.0.1",
        targetPort,
      );
      reader.dispose();
      const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00]);
      socket.write(hello);

      await receivedBytes;

      expect(resolvedUrl).toBe(`https://127.0.0.1:${targetPort}/`);
      expect(received).toEqual(hello);
      socket.destroy();
    } finally {
      await relay.close();
      await close(target);
    }
  }, 5_000);
});
