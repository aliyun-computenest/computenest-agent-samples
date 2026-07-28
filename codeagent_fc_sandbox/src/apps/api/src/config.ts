import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webDistDir: string;
  workspaceRoot: string;
  claudeConfigDir: string;
  agentStateRoot: string;
  preview: {
    scheme: "http" | "https";
    gatewayPort: number;
  };
  fc: {
    apiKey: string;
    apiUrl: string;
    domain: string;
    region: string;
    template: string;
    runtimeAssetsDir: string;
    agentPort: number;
    timeoutMs: number;
    requestTimeoutMs: number;
    runtimeIdleMs: number;
    oss: {
      enabled: boolean;
      bucketName: string;
      endpoint: string;
      roleArn: string;
      rootPrefix: string;
      mountDir: string;
      claudeConfigSubdir: string;
      workspaceSubdir: string;
    };
  };
  claude: {
    authToken: string;
    baseUrl: string;
    model: string;
    sessionModel: "default" | "opus" | "sonnet" | "haiku";
    mode: string;
    haikuModel: string;
    sonnetModel: string;
    opusModel: string;
    subagentModel: string;
  };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_AGENT_STATE_ROOT = "/home/user/.codeagent";
const DEFAULT_WORKSPACE_ROOT = "/home/user/workspace";
const DEFAULT_CLAUDE_CONFIG_DIR = "/home/user/.claude";
const DEFAULT_OSS_MOUNT_DIR = "/mnt/codeagent-persist";

dotenv.config({ path: path.join(rootDir, ".env"), override: false });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(env(name), 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = env(name);
  if (!value) return fallback;
  return value === "true" || value === "1";
}

export function fcApiUrl(region: string): string {
  return `https://api.${region}.e2b.fc.aliyuncs.com`;
}

export function fcDomain(region: string): string {
  return `${region}.e2b.fc.aliyuncs.com`;
}

export function loadConfig(): AppConfig {
  const port = intEnv("PORT", 8000);
  const previewScheme = env("PREVIEW_SCHEME", "http");
  if (previewScheme !== "http" && previewScheme !== "https") {
    throw new Error(`PREVIEW_SCHEME must be http or https. Got: ${previewScheme}`);
  }

  const region = env("FC_E2B_REGION", "cn-beijing");
  const ossEnabled = boolEnv("FC_OSS_PERSISTENCE_ENABLED");
  const ossMountDir = env("FC_OSS_MOUNT_DIR", DEFAULT_OSS_MOUNT_DIR);
  const workspaceSubdir = env("FC_OSS_WORKSPACE_SUBDIR", "workspace");
  const claudeConfigSubdir = env("FC_OSS_CLAUDE_CONFIG_SUBDIR", ".claude");
  const workspaceRoot = ossEnabled
    ? path.posix.join(ossMountDir, workspaceSubdir)
    : DEFAULT_WORKSPACE_ROOT;
  const claudeConfigDir = ossEnabled
    ? path.posix.join(ossMountDir, claudeConfigSubdir)
    : DEFAULT_CLAUDE_CONFIG_DIR;

  return {
    host: env("HOST", "127.0.0.1"),
    port,
    dataDir: env("CODEAGENT_DATA_DIR", path.join(rootDir, "data")),
    webDistDir: env("CODEAGENT_WEB_DIST_DIR", path.join(rootDir, "src/apps/web/dist")),
    workspaceRoot,
    claudeConfigDir,
    agentStateRoot: env("CODEAGENT_STATE_ROOT", DEFAULT_AGENT_STATE_ROOT),
    preview: {
      scheme: previewScheme,
      gatewayPort: intEnv("PREVIEW_GATEWAY_PORT", 5184),
    },
    fc: {
      apiKey: env("E2B_API_KEY"),
      apiUrl: env("E2B_API_URL", fcApiUrl(region)),
      domain: env("E2B_DOMAIN", fcDomain(region)),
      region,
      template: "base",
      runtimeAssetsDir: env("FC_RUNTIME_ASSETS_DIR", path.join(rootDir, "sandbox_image")),
      agentPort: intEnv("FC_E2B_AGENT_PORT", 3001),
      timeoutMs: intEnv("FC_E2B_TIMEOUT_MS", 1_800_000),
      requestTimeoutMs: intEnv("FC_E2B_REQUEST_TIMEOUT_MS", 120_000),
      runtimeIdleMs: intEnv("FC_RUNTIME_IDLE_MS", 600_000),
      oss: {
        enabled: ossEnabled,
        bucketName: env("FC_OSS_BUCKET"),
        endpoint: env("FC_OSS_ENDPOINT"),
        roleArn: env("FC_OSS_ROLE_ARN"),
        rootPrefix: env("FC_OSS_ROOT_PREFIX", "/codeagent/v2"),
        mountDir: ossMountDir,
        claudeConfigSubdir,
        workspaceSubdir,
      },
    },
    claude: {
      authToken: env("DASHSCOPE_API_KEY"),
      baseUrl: env("BAILIAN_BASE_URL", "https://dashscope.aliyuncs.com/apps/anthropic"),
      model: env("DASHSCOPE_MODEL_NAME", "qwen3.7-max"),
      sessionModel: "default",
      mode: "bypassPermissions",
      haikuModel: env("ANTHROPIC_DEFAULT_HAIKU_MODEL", "qwen3.6-flash"),
      sonnetModel: env("ANTHROPIC_DEFAULT_SONNET_MODEL", "qwen3.7-max"),
      opusModel: env("ANTHROPIC_DEFAULT_OPUS_MODEL", "qwen3.7-max"),
      subagentModel: env("CLAUDE_CODE_SUBAGENT_MODEL", "qwen3.7-max"),
    },
  };
}

export function assertConfig(config: AppConfig): void {
  const missing: string[] = [];
  if (!config.fc.apiKey) missing.push("E2B_API_KEY");
  if (!config.claude.authToken) missing.push("DASHSCOPE_API_KEY");
  if (config.fc.oss.enabled) {
    if (!config.fc.oss.bucketName) missing.push("FC_OSS_BUCKET");
    if (!config.fc.oss.endpoint) missing.push("FC_OSS_ENDPOINT");
    if (!config.fc.oss.roleArn) missing.push("FC_OSS_ROLE_ARN");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (!/^[a-z0-9-]+$/.test(config.fc.region)) {
    throw new Error(`Invalid FC_E2B_REGION: ${config.fc.region}`);
  }
}
