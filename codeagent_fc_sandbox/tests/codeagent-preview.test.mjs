import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helper = path.resolve("sandbox_image/bin/codeagent_preview.py");

test("codeagent-preview 发布前验证外部 Host 并原子写入 manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-preview-"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("ok");
  });
  await listen(server);
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await runHelper(root, [
    "publish",
    "--port",
    String(port),
    "--cwd",
    root,
    "--start-command",
    "npm run dev -- --host 0.0.0.0",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "preview.json"), "utf8"));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.targetPort, port);
  assert.equal(manifest.projectRoot, await fs.realpath(root));
  assert.equal(manifest.startCommand, "npm run dev -- --host 0.0.0.0");
});

test("codeagent-preview 对拒绝动态 Host 的开发服务器给出可操作错误", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-preview-host-"));
  const server = http.createServer((request, response) => {
    const allowed = request.headers.host === `127.0.0.1:${server.address().port}`;
    response.writeHead(allowed ? 200 : 403, { "content-type": "text/plain" });
    response.end(allowed ? "ok" : "blocked host");
  });
  await listen(server);
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await runHelper(root, ["publish", "--port", String(port), "--cwd", root]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /rejected an external Host header/);
  assert.match(result.stdout, /server\.allowedHosts=true/);
  await assert.rejects(fs.readFile(path.join(root, "preview.json")), { code: "ENOENT" });
});

test("codeagent-preview 拒绝 FC 公网范围以下的端口", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-preview-port-"));
  try {
    const result = await runHelper(root, ["publish", "--port", "2999", "--cwd", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /invalid choice/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function runHelper(stateRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [helper, ...args], {
      env: { ...process.env, CODEAGENT_STATE_ROOT: stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
