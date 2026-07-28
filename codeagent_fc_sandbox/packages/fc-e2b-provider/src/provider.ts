import { createHash } from "node:crypto";
import path from "node:path/posix";
import {
  Sandbox,
  SandboxNotFoundError,
  type SandboxConnectOpts,
  type SandboxOpts,
} from "e2b";
import type { SandboxProvider } from "sandbox-agent";
import { ensureRuntimeInstalled } from "./runtime-installer.js";

const DEFAULT_AGENT_PORT = 3001;
const HEALTH_PATH = "/v1/health";
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const FC_OSS_BUCKET_PATH_MAX_BYTES = 128;

export interface FcE2BClaudeConfig {
  authToken: string;
  baseUrl: string;
  model: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  subagentModel: string;
}

export interface FcE2BSandboxProviderConfig {
  apiKey: string;
  apiUrl: string;
  domain: string;
  template: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  runtimeAssetsDir: string;
  workspaceRoot: string;
  claudeConfigDir: string;
  agentStateRoot: string;
  agentPort?: number;
  oss?: FcE2BOssConfig;
  claude: FcE2BClaudeConfig;
}

export interface FcE2BOssConfig {
  bucketName: string;
  endpoint: string;
  roleArn: string;
  rootPrefix: string;
  mountDir: string;
}

export interface FcE2BSessionIdentity {
  sessionId: string;
  userId: string;
  projectId: string;
}

export interface FcE2BSessionStorageContext {
  readonly ossPrefix: string;
}

export interface FcE2BCommandRunner {
  run(
    command: string,
    options?: {
      background?: boolean;
      timeoutMs?: number;
      envs?: Record<string, string>;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface FcE2BFilesystem {
  write(path: string, data: string): Promise<unknown>;
}

export interface FcE2BSandboxHandle {
  readonly sandboxId: string;
  readonly commands: FcE2BCommandRunner;
  readonly files: FcE2BFilesystem;
  getHost(port: number): string;
  kill(): Promise<boolean>;
}

export interface FcE2BClient {
  create(
    template: string,
    options: SandboxOpts,
  ): Promise<FcE2BSandboxHandle>;
  connect(
    sandboxId: string,
    options: SandboxConnectOpts,
  ): Promise<FcE2BSandboxHandle>;
}

export interface FcE2BSandboxProviderOptions {
  config: FcE2BSandboxProviderConfig;
  client?: FcE2BClient;
  fetchImpl?: typeof fetch;
}

const defaultClient: FcE2BClient = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
};

export class FcE2BSandboxProvider implements SandboxProvider {
  readonly name = "fc-e2b";
  readonly defaultCwd: string;
  readonly usesOss: boolean;

  private readonly config: FcE2BSandboxProviderConfig;
  private readonly client: FcE2BClient;
  private readonly fetchImpl: typeof fetch;
  private readonly agentPort: number;
  private readonly sandboxes = new Map<string, FcE2BSandboxHandle>();

  constructor(options: FcE2BSandboxProviderOptions) {
    const oss = options.config.oss ? normalizeOssConfig(options.config.oss) : undefined;
    const claudeConfigDir = options.config.claudeConfigDir?.trim() || "/home/user/.claude";
    this.config = { ...options.config, claudeConfigDir, oss };
    this.client = options.client ?? defaultClient;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.agentPort = options.config.agentPort ?? DEFAULT_AGENT_PORT;
    this.defaultCwd = options.config.workspaceRoot;
    this.usesOss = Boolean(oss);

    if (!Number.isInteger(this.agentPort) || this.agentPort < 3_000 || this.agentPort > 65_535) {
      throw new Error(`Invalid FC E2B sandbox-agent port: ${this.agentPort}`);
    }
    if (oss) validateOssPaths(oss.mountDir, this.config.workspaceRoot, this.config.claudeConfigDir);
  }

  async create(): Promise<string> {
    if (this.config.oss) {
      throw new Error("FC OSS persistence requires an immutable session context; use createForSession()");
    }
    return this.createSandbox();
  }

  storagePrefixFor(identity: FcE2BSessionIdentity): string {
    const oss = this.config.oss;
    if (!oss) throw new Error("FC OSS persistence is not enabled");
    return buildSessionOssPrefix(oss.rootPrefix, identity);
  }

  async createForSession(context: FcE2BSessionStorageContext): Promise<string> {
    const oss = this.config.oss;
    if (!oss) throw new Error("FC OSS persistence is not enabled");
    const ossPrefix = normalizeSessionPrefix(context.ossPrefix, oss.rootPrefix);
    return this.createSandbox(ossPrefix);
  }

  private async createSandbox(ossPrefix?: string): Promise<string> {
    const sandbox = await this.client.create(
      this.config.template,
      this.createOptions(ossPrefix),
    );
    this.sandboxes.set(sandbox.sandboxId, sandbox);

    try {
      await ensureRuntimeInstalled(sandbox, this.config.runtimeAssetsDir);
      await this.ensureServerOn(sandbox);
      return sandbox.sandboxId;
    } catch (error) {
      this.sandboxes.delete(sandbox.sandboxId);
      await sandbox.kill().catch(() => false);
      throw error;
    }
  }

  async connect(sandboxId: string): Promise<FcE2BSandboxHandle> {
    const sandbox = await this.connectHandle(sandboxId);
    await ensureRuntimeInstalled(sandbox, this.config.runtimeAssetsDir);
    await this.ensureServerOn(sandbox);
    return sandbox;
  }

  async ensureServer(sandboxId: string): Promise<void> {
    const sandbox = await this.connectHandle(sandboxId);
    await ensureRuntimeInstalled(sandbox, this.config.runtimeAssetsDir);
    await this.ensureServerOn(sandbox);
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      const sandbox = this.sandboxes.get(sandboxId)
        ?? await this.client.connect(sandboxId, this.connectOptions());
      await sandbox.kill();
    } finally {
      this.sandboxes.delete(sandboxId);
    }
  }

  async getUrl(sandboxId: string): Promise<string> {
    return this.getPortUrl(sandboxId, this.agentPort);
  }

  async getPortUrl(sandboxId: string, port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 3_000 || port > 65_535) {
      throw new Error(`Invalid FC E2B port: ${port}`);
    }
    const sandbox = this.sandboxes.get(sandboxId)
      ?? await this.connectHandle(sandboxId);
    return `https://${sandbox.getHost(port)}`;
  }

  private async connectHandle(sandboxId: string): Promise<FcE2BSandboxHandle> {
    const sandbox = await this.client.connect(sandboxId, this.connectOptions());
    this.sandboxes.set(sandboxId, sandbox);
    return sandbox;
  }

  private async ensureServerOn(sandbox: FcE2BSandboxHandle): Promise<void> {
    const healthUrl = `${await this.getPortUrl(sandbox.sandboxId, this.agentPort)}${HEALTH_PATH}`;
    if (await this.isHealthy(healthUrl)) return;

    await sandbox.commands.run(
      [
        "{",
        "if [ -x /usr/local/bin/start-sandbox-agent ]; then",
        `  exec env SANDBOX_AGENT_PORT=${this.agentPort} /usr/local/bin/start-sandbox-agent`,
        "fi",
        `exec sandbox-agent server --no-token --host 0.0.0.0 --port ${this.agentPort}`,
        "} >/tmp/sandbox-agent.log 2>&1",
      ].join("\n"),
      {
        background: true,
        timeoutMs: 0,
        envs: this.buildSandboxEnvironment(),
      },
    );
    await this.waitForHealth(sandbox.sandboxId, healthUrl);
  }

  private async isHealthy(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      try {
        return response.ok;
      } finally {
        await discardResponseBody(response);
      }
    } catch {
      return false;
    }
  }

  private async waitForHealth(sandboxId: string, url: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        });
        try {
          if (response.ok) return;
          lastError = new Error(`health returned HTTP ${response.status}`);
        } finally {
          await discardResponseBody(response);
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(
      `sandbox-agent server is not healthy in FC E2B sandbox ${sandboxId}: ${String(lastError)}`,
    );
  }

  private createOptions(ossPrefix?: string): SandboxOpts {
    const options: SandboxOpts = {
      ...this.connectionOptions(),
      timeoutMs: this.config.timeoutMs,
      secure: false,
      envs: this.buildSandboxEnvironment(ossPrefix),
    };
    const oss = this.config.oss;
    if (oss) {
      if (!ossPrefix) throw new Error("FC OSS session prefix is required");
      options.metadata = {
        "fc.sandbox.storage.oss": JSON.stringify({
          mountPoints: [{
            bucketName: oss.bucketName,
            bucketPath: ossPrefix,
            mountDir: oss.mountDir,
            endpoint: oss.endpoint,
            readOnly: false,
          }],
        }),
        "fc.sandbox.auth.role": oss.roleArn,
      };
    }
    return options;
  }

  private connectOptions(): SandboxConnectOpts {
    return {
      ...this.connectionOptions(),
      timeoutMs: this.config.timeoutMs,
    };
  }

  private connectionOptions(): SandboxConnectOpts {
    return {
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      domain: this.config.domain,
      requestTimeoutMs: this.config.requestTimeoutMs,
    };
  }

  private buildSandboxEnvironment(ossPrefix?: string): Record<string, string> {
    const env: Record<string, string> = {
      WORKSPACE: this.config.workspaceRoot,
      CLAUDE_CONFIG_DIR: this.config.claudeConfigDir,
      CODEAGENT_STATE_ROOT: this.config.agentStateRoot,
      ANTHROPIC_BASE_URL: this.config.claude.baseUrl,
      ANTHROPIC_MODEL: this.config.claude.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: this.config.claude.haikuModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.config.claude.sonnetModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.config.claude.opusModel,
      CLAUDE_CODE_SUBAGENT_MODEL: this.config.claude.subagentModel,
    };
    if (this.config.claude.authToken) {
      env.ANTHROPIC_AUTH_TOKEN = this.config.claude.authToken;
      env.DASHSCOPE_API_KEY = this.config.claude.authToken;
    }
    if (this.config.oss) {
      env.FC_OSS_MOUNT_DIR = this.config.oss.mountDir;
      if (ossPrefix) env.FC_OSS_BUCKET_PATH = ossPrefix;
    }
    return env;
  }
}

export function buildSessionOssPrefix(rootPrefix: string, identity: FcE2BSessionIdentity): string {
  const root = normalizeRootPrefix(rootPrefix);
  const prefix = path.join(
    root,
    "u",
    stableStorageSegment(identity.userId, "userId"),
    "p",
    stableStorageSegment(identity.projectId, "projectId"),
    "s",
    stableStorageSegment(identity.sessionId, "sessionId"),
  );
  assertBucketPathLength(prefix);
  return prefix;
}

export function isFcSandboxNotFoundError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (current instanceof SandboxNotFoundError) return true;
    const record = current as {
      name?: unknown;
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const message = typeof record.message === "string" ? record.message : "";
    const status = Number(record.statusCode ?? record.status);
    if (record.name === "SandboxNotFoundError") return true;
    if (record.code === "SandboxNotFound") return true;
    if (
      status === 404
      && /sandbox/i.test(message)
      && /not found|does not exist|no longer running|terminated/i.test(message)
    ) return true;
    current = record.cause;
  }
  return false;
}

function normalizeOssConfig(config: FcE2BOssConfig): FcE2BOssConfig {
  const normalized = {
    bucketName: requiredValue(config.bucketName, "FC OSS bucket"),
    endpoint: requiredValue(config.endpoint, "FC OSS endpoint"),
    roleArn: requiredValue(config.roleArn, "FC OSS role ARN"),
    rootPrefix: normalizeRootPrefix(config.rootPrefix),
    mountDir: normalizeAbsolutePath(config.mountDir, "FC OSS mount directory"),
  };
  return normalized;
}

function normalizeRootPrefix(value: string): string {
  const normalized = path.normalize(`/${requiredValue(value, "FC OSS root prefix")}`).replace(/\/$/, "");
  if (normalized === "/") throw new Error("FC OSS root prefix cannot be the bucket root");
  return normalized;
}

function normalizeSessionPrefix(value: string, rootPrefix: string): string {
  const normalized = path.normalize(`/${requiredValue(value, "FC OSS session prefix")}`).replace(/\/$/, "");
  const relative = path.relative(rootPrefix, normalized);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`FC OSS session prefix must be below root prefix '${rootPrefix}': ${value}`);
  }
  assertBucketPathLength(normalized);
  return normalized;
}

function validateOssPaths(mountDir: string, workspaceRoot: string, claudeConfigDir: string): void {
  const normalizedPaths = new Map<string, string>();
  for (const [label, candidate] of [
    ["workspaceRoot", workspaceRoot],
    ["claudeConfigDir", claudeConfigDir],
  ] as const) {
    const normalized = normalizeAbsolutePath(candidate, label);
    normalizedPaths.set(label, normalized);
    const relative = path.relative(mountDir, normalized);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} must be a child of FC OSS mount directory '${mountDir}': ${candidate}`);
    }
  }
  const workspace = normalizedPaths.get("workspaceRoot")!;
  const claude = normalizedPaths.get("claudeConfigDir")!;
  if (pathsOverlap(workspace, claude)) {
    throw new Error(
      `workspaceRoot and claudeConfigDir must be separate sibling trees inside the FC OSS mount: '${workspace}', '${claude}'`,
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative));
}

function normalizeAbsolutePath(value: string, label: string): string {
  const normalized = path.normalize(requiredValue(value, label));
  if (!path.isAbsolute(normalized)) throw new Error(`${label} must be an absolute POSIX path: ${value}`);
  return normalized.replace(/\/$/, "") || "/";
}

function stableStorageSegment(value: string, label: string): string {
  const input = requiredValue(value, label);
  const readable = input
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 8) || label.toLowerCase().slice(0, 8);
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

function assertBucketPathLength(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > FC_OSS_BUCKET_PATH_MAX_BYTES) {
    throw new Error(
      `FC OSS bucketPath exceeds ${FC_OSS_BUCKET_PATH_MAX_BYTES} bytes (${bytes}): ${value}`,
    );
  }
}

function requiredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Health checks only need status; body cleanup must not replace the real result.
  }
}
