import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { PreviewGateway } from "../src/apps/api/dist/services/preview-gateway.js";

test("FC fixed preview gateway isolates browser sessions and proxies root assets and websocket upgrades", async (t) => {
  let upgradedUrl = "";
  const firstUpstream = createServer((incoming, response) => {
    assert.notEqual(incoming.headers.cookie, undefined);
    response.writeHead(200, {
      "content-disposition": "attachment",
      "content-security-policy": "default-src 'none'",
      "content-type": "text/javascript; charset=utf-8",
    });
    response.end(`first:${incoming.url}`);
  });
  firstUpstream.on("upgrade", (request, socket) => {
    upgradedUrl = request.url ?? "";
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const firstPort = await listen(firstUpstream);
  t.after(() => firstUpstream.close());

  const secondUpstream = createServer((incoming, response) => response.end(`second:${incoming.url}`));
  const secondPort = await listen(secondUpstream);
  t.after(() => secondUpstream.close());

  const gatewayPort = await availablePort();
  const gateway = new PreviewGateway(gatewayPort);
  await gateway.listen("127.0.0.1");
  t.after(() => gateway.close());

  const control = createServer((request, response) => {
    const sessionId = new URL(request.url ?? "/", "http://control").searchParams.get("session") ?? "";
    const target = sessionId === "sess_one" ? `http://127.0.0.1:${firstPort}` : `http://127.0.0.1:${secondPort}`;
    response.end(gateway.activate(request, response, sessionId, target));
  });
  const controlPort = await listen(control);
  t.after(() => control.close());

  const first = await activate(controlPort, "sess_one");
  const second = await activate(controlPort, "sess_two");
  assert.equal(first.origin, `http://127.0.0.1:${gatewayPort}`);
  assert.notEqual(first.cookie, second.cookie);

  const firstResult = await fetch(`${first.origin}/src/main.js?direct=1`, {
    headers: { cookie: `${first.cookie}; app_session=kept` },
  });
  assert.equal(firstResult.status, 200);
  assert.equal(firstResult.headers.get("content-disposition"), null);
  assert.equal(firstResult.headers.get("content-security-policy"), null);
  assert.equal(await firstResult.text(), "first:/src/main.js?direct=1");

  const secondResult = await fetch(`${second.origin}/`, { headers: { cookie: second.cookie } });
  assert.equal(await secondResult.text(), "second:/");

  const shared = await activate(controlPort, "sess_one", { clientId: "shared-browser", selection: 10 });
  await activate(controlPort, "sess_two", { clientId: "shared-browser", selection: 12, cookie: shared.cookie });
  await activate(controlPort, "sess_one", { clientId: "shared-browser", selection: 11, cookie: shared.cookie });
  const selectedResult = await fetch(`${shared.origin}/selected`, { headers: { cookie: shared.cookie } });
  assert.equal(await selectedResult.text(), "second:/selected");

  const websocketResponse = await rawUpgrade(gatewayPort, first.cookie, "/socket?token=vite-token");
  assert.match(websocketResponse, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.equal(upgradedUrl, "/socket?token=vite-token");
});

test("preview gateway bounds client bindings and clears cached routes on close", async () => {
  const gateway = new PreviewGateway(0);
  const response = { setHeader() {} };

  for (let index = 0; index <= 1_024; index += 1) {
    gateway.activate(
      {
        headers: {
          host: "127.0.0.1",
          "x-codeagent-preview-client-id": `client-${index}`,
          "x-codeagent-preview-selection": "1",
        },
      },
      response,
      `session-${index}`,
      `http://127.0.0.1:${3_000 + index}`,
    );
  }

  assert.equal(gateway.clients.size, 1_024);
  assert.equal(gateway.clients.has("client-0"), false);
  assert.equal(gateway.clients.has("client-1024"), true);
  assert.equal(gateway.targets.has("session-0"), false);
  assert.equal(gateway.targets.has("session-1024"), true);

  await gateway.close();
  assert.equal(gateway.clients.size, 0);
  assert.equal(gateway.targets.size, 0);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function activate(port, sessionId, options = {}) {
  const headers = {};
  if (options.clientId) headers["x-codeagent-preview-client-id"] = options.clientId;
  if (options.selection !== undefined) headers["x-codeagent-preview-selection"] = String(options.selection);
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`http://127.0.0.1:${port}/?session=${sessionId}`, { headers });
  return {
    origin: await response.text(),
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? options.cookie,
  };
}

function rawUpgrade(port, cookie, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(3_000);
    socket.once("connect", () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once("timeout", () => reject(new Error("websocket upgrade timed out")));
    socket.once("error", reject);
  });
}
