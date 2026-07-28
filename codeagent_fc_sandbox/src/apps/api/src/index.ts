import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import type { SessionEvent } from "sandbox-agent";
import { z } from "zod";
import { FcE2BSandboxProvider } from "@codeagent-sandbox-demo/fc-e2b-provider";
import {
  BusinessSessionStore,
  createBusinessSessionId,
  FileSessionPersistDriver,
  type BusinessSession,
} from "@codeagent-sandbox-demo/core";
import { assertConfig, loadConfig } from "./config.js";
import { AgentSessionManager, isAcpTransportFailure } from "./services/agent-session-manager.js";
import { PreviewGateway } from "./services/preview-gateway.js";

const config = loadConfig();
assertConfig(config);

const app = Fastify({ logger: true });
const provider = new FcE2BSandboxProvider({
  config: {
    apiKey: config.fc.apiKey,
    apiUrl: config.fc.apiUrl,
    domain: config.fc.domain,
    template: config.fc.template,
    timeoutMs: config.fc.timeoutMs,
    requestTimeoutMs: config.fc.requestTimeoutMs,
    agentPort: config.fc.agentPort,
    runtimeAssetsDir: config.fc.runtimeAssetsDir,
    workspaceRoot: config.workspaceRoot,
    claudeConfigDir: config.claudeConfigDir,
    agentStateRoot: config.agentStateRoot,
    oss: config.fc.oss.enabled
      ? {
          bucketName: config.fc.oss.bucketName,
          endpoint: config.fc.oss.endpoint,
          roleArn: config.fc.oss.roleArn,
          rootPrefix: config.fc.oss.rootPrefix,
          mountDir: config.fc.oss.mountDir,
        }
      : undefined,
    claude: config.claude,
  },
});
const persist = new FileSessionPersistDriver(config.dataDir);
const businessStore = new BusinessSessionStore(config.dataDir);
await persist.init();
await businessStore.init();
const previewGateway = new PreviewGateway(
  config.preview.gatewayPort,
  config.preview.scheme,
);
const manager = new AgentSessionManager(config, provider, persist, businessStore, {
  onSandboxIdChanged: (sessionId) => previewGateway.clearTarget(sessionId),
});
await manager.start();

process.on("unhandledRejection", (error: unknown) => {
  if (!isAcpTransportFailure(error)) {
    setImmediate(() => {
      throw error;
    });
    return;
  }
  app.log.error({ err: error }, "ACP transport failed; resetting live sandbox connections");
  void manager.recoverTransportFailure(error);
});
app.addHook("onClose", async () => {
  await previewGateway.close();
  await manager.close();
});
await app.register(cors, { origin: true });
await app.register(staticPlugin, {
  root: config.webDistDir,
  prefix: "/",
  decorateReply: false,
  wildcard: false,
});

const createSessionSchema = z.object({
  userId: z.string().default("user-1"),
  projectId: z.string().default("project-1"),
  title: z.string().optional(),
});

const messageSchema = z.object({
  content: z.string().min(1),
});

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function errorMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.code === "string" && record.code.trim()) return record.code;
    current = record.cause;
  }
  if (typeof error === "string" && error.trim()) return error;
  return "Unexpected internal error; check the CodeAgent server log for details";
}

app.setErrorHandler((error, request, reply) => {
  const record = error && typeof error === "object"
    ? error as { statusCode?: unknown; name?: unknown }
    : {};
  const candidateStatus = Number(record.statusCode);
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400
    ? candidateStatus
    : 500;
  const message = errorMessage(error);
  request.log.error({ err: error, statusCode }, "CodeAgent request failed");
  return reply.code(statusCode).send({
    statusCode,
    error: statusCode >= 500
      ? "Internal Server Error"
      : typeof record.name === "string" && record.name ? record.name : "Request Error",
    message,
  });
});

function isCompatibleSession(session: BusinessSession): boolean {
  if (session.runtimeProvider !== "fc-e2b") return false;
  if (!config.fc.oss.enabled) return true;
  return Boolean(
    session.ossPrefix
    && session.workspaceRoot === config.workspaceRoot
    && session.claudeConfigDir === config.claudeConfigDir,
  );
}

app.get("/health", async () => ({
  status: "ok",
  stack: "typescript",
  provider: "fc-e2b",
  template: config.fc.template,
  region: config.fc.region,
  apiUrl: config.fc.apiUrl,
  persistence: config.fc.oss.enabled ? "oss" : "sandbox-local",
  workspaceRoot: config.workspaceRoot,
  claudeConfigDir: config.claudeConfigDir,
}));

app.get("/api/sessions", async () => (await businessStore.list()).filter(isCompatibleSession));

app.post("/api/sessions", async (request, reply) => {
  const body = createSessionSchema.parse(request.body ?? {});
  const id = createBusinessSessionId();
  const ossPrefix = provider.usesOss
    ? provider.storagePrefixFor({ sessionId: id, userId: body.userId, projectId: body.projectId })
    : undefined;
  const session = await businessStore.create({
    id,
    runtimeProvider: "fc-e2b",
    userId: body.userId,
    projectId: body.projectId,
    title: body.title || body.projectId || id,
    status: "creating",
    ossPrefix,
    templateName: config.fc.template,
    workspaceRoot: config.workspaceRoot,
    claudeConfigDir: config.claudeConfigDir,
    recoveryEpoch: 0,
  });

  void manager.prepare(id).catch(async (error: unknown) => {
    await businessStore.update(id, (current) => {
      if (
        current.status === "deleted"
        || current.status === "terminated"
        || current.status === "deleting"
        || current.status === "delete_failed"
      ) return undefined;
      if (current.status === "failed" && current.error) return undefined;
      return { ...current, status: "failed", error: errorMessage(error) };
    });
  });

  return reply.code(202).send(session);
});

app.get("/api/sessions/:sessionId", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  const session = await businessStore.get(sessionId);
  if (!session || session.runtimeProvider !== "fc-e2b") throw httpError(404, "session not found");
  if (!isCompatibleSession(session)) {
    throw httpError(409, "session uses a legacy sandbox layout; create a new OSS-backed session");
  }
  return session;
});

app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = messageSchema.parse(request.body ?? {});
  await manager.sendMessage(sessionId, body.content);
  return reply.code(202).send({ ok: true });
});

app.get("/api/sessions/:sessionId/events", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const query = request.query as { offset?: string };
  const lastEventId = Array.isArray(request.headers["last-event-id"])
    ? request.headers["last-event-id"][0]
    : request.headers["last-event-id"];
  let offset = Number.parseInt(lastEventId ?? query.offset ?? "0", 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: () => void = () => undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };

  const write = async (chunk: string): Promise<boolean> => {
    if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
    try {
      if (reply.raw.write(chunk)) return true;
      return await new Promise<boolean>((resolve) => {
        const settle = (writable: boolean) => {
          reply.raw.off("drain", onDrain);
          reply.raw.off("close", onClose);
          reply.raw.off("error", onError);
          resolve(writable);
        };
        const onDrain = () => settle(true);
        const onClose = () => settle(false);
        const onError = () => settle(false);
        reply.raw.once("drain", onDrain);
        reply.raw.once("close", onClose);
        reply.raw.once("error", onError);
      });
    } catch (error) {
      request.log.debug({ err: error, sessionId }, "SSE write failed");
      cleanup();
      return false;
    }
  };

  const send = async (event: SessionEvent): Promise<boolean> => {
    if (event.eventIndex <= offset) return true;
    const written = await write(`id: ${event.eventIndex}\ndata: ${JSON.stringify(event)}\n\n`);
    if (written) offset = event.eventIndex;
    return written;
  };

  reply.raw.on("error", (error) => {
    request.log.debug({ err: error, sessionId }, "SSE response closed with an error");
    cleanup();
  });
  request.raw.on("close", cleanup);

  for (const event of await manager.listEvents(sessionId, offset)) {
    if (!(await send(event))) return;
  }

  let writeQueue = Promise.resolve();
  unsubscribe = manager.subscribeEvents(sessionId, (event) => {
    writeQueue = writeQueue
      .then(async () => {
        if (!(await send(event))) cleanup();
      })
      .catch((error: unknown) => {
        request.log.error({ err: error, sessionId }, "Failed to send SSE event");
        cleanup();
      });
  });
  heartbeat = setInterval(() => {
    writeQueue = writeQueue.then(async () => {
      if (!(await write(": ping\n\n"))) cleanup();
    });
  }, 15_000);
});

app.get("/api/sessions/:sessionId/files", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  const { path = "" } = request.query as { path?: string };
  return manager.listFiles(sessionId, path);
});

app.get("/api/sessions/:sessionId/workspace/snapshot", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  return manager.workspaceSnapshot(sessionId);
});

app.get("/api/sessions/:sessionId/files/content", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const { path } = request.query as { path?: string };
  if (!path) throw httpError(400, "path is required");
  const bytes = await manager.readFile(sessionId, path);
  return reply.type("text/plain; charset=utf-8").send(Buffer.from(bytes));
});

app.put("/api/sessions/:sessionId/files/content", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  const { path } = request.query as { path?: string };
  if (!path) throw httpError(400, "path is required");
  const body = typeof request.body === "string" || request.body instanceof Buffer ? request.body : JSON.stringify(request.body ?? "");
  return manager.writeFile(sessionId, path, body);
});

app.get("/api/sessions/:sessionId/preview/status", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const status = await manager.getPreviewStatus(sessionId);
  if (status.status === "ready" && status.origin) {
    return { ...status, origin: previewGateway.activate(request.raw, reply.raw, sessionId, status.origin) };
  }
  previewGateway.clearTarget(sessionId);
  previewGateway.activate(request.raw, reply.raw, sessionId);
  return status;
});

app.post("/api/sessions/:sessionId/preview/start", async (_request, reply) => {
  return reply.code(410).send({ error: "preview is started and published by the AI inside the sandbox" });
});

app.delete("/api/sessions/:sessionId", async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  previewGateway.clearTarget(sessionId);
  const deleted = await manager.deleteSession(sessionId);
  previewGateway.remove(sessionId);
  return deleted;
});

app.setNotFoundHandler((request, reply) => {
  const acceptsHtml = String(request.headers.accept ?? "").includes("text/html");
  if (request.method === "GET" && acceptsHtml && !request.url.startsWith("/api/")) {
    return reply.sendFile("index.html");
  }
  return reply.code(404).send({ error: "not found" });
});

await previewGateway.listen(config.host);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await previewGateway.close();
  throw error;
}
