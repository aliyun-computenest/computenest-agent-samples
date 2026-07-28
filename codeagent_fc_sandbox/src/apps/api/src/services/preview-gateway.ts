import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";

const CLIENT_COOKIE = "codeagent_fc_preview_client";
const MAX_PREVIEW_CLIENTS = 1_024;

export class PreviewGateway {
  private readonly clients = new Map<string, { sessionId: string; selection: number }>();
  private readonly targets = new Map<string, string>();
  private readonly proxy: httpProxy;
  private readonly server: Server;

  constructor(
    private readonly port: number,
    private readonly scheme: "http" | "https" = "http",
  ) {
    this.proxy = httpProxy.createProxyServer({
      autoRewrite: true,
      changeOrigin: true,
      cookieDomainRewrite: "",
      protocolRewrite: scheme,
      secure: true,
      ws: true,
      xfwd: true,
    });
    this.proxy.on("proxyRes", (proxyResponse) => {
      delete proxyResponse.headers["content-disposition"];
      // Preview apps are served from a separate origin and embedded in CodeAgent's iframe.
      // Upstream X-Frame-Options/CSP can block that embedding, so this controlled-demo
      // gateway strips them. Removing the whole CSP weakens other protections; production
      // deployments must enforce authentication, access control, and network isolation.
      delete proxyResponse.headers["x-frame-options"];
      delete proxyResponse.headers["content-security-policy"];
      delete proxyResponse.headers["content-security-policy-report-only"];
    });
    this.server = createServer((request, response) => this.proxyHttp(request, response));
    this.server.on("upgrade", (request, socket, head) => this.proxyWebSocket(request, socket, head));
  }

  async listen(host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.clients.clear();
    this.targets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  activate(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
    targetOrigin?: string,
  ): string {
    const cookieClientId = cookieValue(request.headers.cookie, CLIENT_COOKIE);
    const requestedClientId = firstHeader(request.headers["x-codeagent-preview-client-id"]);
    const clientId = validClientId(requestedClientId) ?? cookieClientId ?? randomUUID();
    if (cookieClientId !== clientId) {
      response.setHeader("set-cookie", `${CLIENT_COOKIE}=${clientId}; Path=/; HttpOnly; SameSite=Lax`);
    }
    const selection = Number(firstHeader(request.headers["x-codeagent-preview-selection"]) ?? "0");
    const normalizedSelection = Number.isFinite(selection) ? selection : 0;
    const current = this.clients.get(clientId);
    if (!current || normalizedSelection >= current.selection) {
      this.clients.delete(clientId);
      this.clients.set(clientId, { sessionId, selection: normalizedSelection });
      if (current && current.sessionId !== sessionId) this.clearTargetIfUnused(current.sessionId);
      this.evictExcessClients();
    }
    if (targetOrigin && this.clients.get(clientId)?.sessionId === sessionId) {
      this.targets.set(sessionId, targetOrigin);
    }
    return previewOrigin(request, this.port, this.scheme);
  }

  clearTarget(sessionId: string): void {
    this.targets.delete(sessionId);
  }

  remove(sessionId: string): void {
    this.targets.delete(sessionId);
    for (const [clientId, selected] of this.clients) {
      if (selected.sessionId === sessionId) this.clients.delete(clientId);
    }
  }

  private evictExcessClients(): void {
    while (this.clients.size > MAX_PREVIEW_CLIENTS) {
      const oldestClientId = this.clients.keys().next().value;
      if (!oldestClientId) return;
      const sessionId = this.clients.get(oldestClientId)?.sessionId;
      this.clients.delete(oldestClientId);
      if (sessionId) this.clearTargetIfUnused(sessionId);
    }
  }

  private clearTargetIfUnused(sessionId: string): void {
    for (const selected of this.clients.values()) {
      if (selected.sessionId === sessionId) return;
    }
    this.targets.delete(sessionId);
  }

  private proxyHttp(request: IncomingMessage, response: ServerResponse): void {
    const target = this.target(request);
    if (!target) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("Open a CodeAgent session before loading its preview.");
      return;
    }
    stripCookie(request, CLIENT_COOKIE);
    this.proxy.web(request, response, { target }, () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (!response.writableEnded) response.end("Preview gateway could not reach the sandbox application.");
    });
  }

  private proxyWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.target(request);
    if (!target) {
      socket.destroy();
      return;
    }
    stripCookie(request, CLIENT_COOKIE);
    this.proxy.ws(request, socket, head, { target }, (error) => socket.destroy(error));
  }

  private target(request: IncomingMessage): string | undefined {
    const clientId = cookieValue(request.headers.cookie, CLIENT_COOKIE);
    const sessionId = clientId ? this.clients.get(clientId)?.sessionId : undefined;
    return sessionId ? this.targets.get(sessionId) : undefined;
  }
}

function previewOrigin(request: IncomingMessage, port: number, scheme: "http" | "https"): string {
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const hostname = new URL(`${scheme}://${forwardedHost ?? request.headers.host ?? "127.0.0.1"}`).hostname;
  return `${scheme}://${hostname}:${port}`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

function validClientId(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function stripCookie(request: IncomingMessage, name: string): void {
  const value = (request.headers.cookie?.split(";") ?? [])
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator < 0 || part.slice(0, separator).trim() !== name;
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");
  if (value) request.headers.cookie = value;
  else delete request.headers.cookie;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
