import { Sandbox } from "e2b";
import { SandboxAgent } from "sandbox-agent";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true, override: true });

const apiKey = process.env.E2B_API_KEY;
const apiUrl = process.env.E2B_API_URL ?? "https://api.cn-beijing.e2b.fc.aliyuncs.com";
const domain = process.env.E2B_DOMAIN ?? "cn-beijing.e2b.fc.aliyuncs.com";
const template = process.env.FC_E2B_TEMPLATE ?? "base";
const agentPort = Number(process.env.FC_E2B_AGENT_PORT ?? 3001);
const installClaudeCommand = [
  "set -eu",
  "(",
  "  while :; do",
  "    for f in /proc/[0-9]*/cmdline; do",
  "      process_dir=${f%/cmdline}",
  "      [ \"$(cat \"$process_dir/comm\" 2>/dev/null || true)\" = node ] || continue",
  "      command=$(tr '\\0' ' ' < \"$f\" 2>/dev/null || true)",
  "      case \"$command\" in *claude-agent-acp*--help*) kill \"${process_dir#/proc/}\" 2>/dev/null || true; exit 0;; esac",
  "    done",
  "    sleep 1",
  "  done",
  ") &",
  "watcher=$!",
  "cleanup() { kill \"$watcher\" 2>/dev/null || true; }",
  "trap cleanup EXIT",
  "sudo -u user -H env NPM_CONFIG_REGISTRY=https://registry.npmmirror.com npm_config_registry=https://registry.npmmirror.com sandbox-agent install-agent claude --agent-version 2.1.191 --agent-process-version 0.51.0",
  "cleanup",
  "trap - EXIT",
].join("\n");
const sandboxEnvs = Object.fromEntries(
  [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
if (process.env.BAILIAN_BASE_URL) {
  sandboxEnvs.ANTHROPIC_BASE_URL = process.env.BAILIAN_BASE_URL;
}

if (!apiKey) {
  throw new Error("E2B_API_KEY is required");
}
const sandbox = await Sandbox.create(template, {
  apiKey,
  apiUrl,
  domain,
  envs: sandboxEnvs,
  timeoutMs: 10 * 60 * 1000,
});
console.log(`sandbox created: ${sandbox.sandboxId}`);

async function waitForHttp(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError;
}

try {
  let runtimeMode = "template";
  let version = await sandbox.commands.run(
    "if command -v sandbox-agent >/dev/null 2>&1; then sandbox-agent --version; fi",
  );
  if (!version.stdout.trim() && process.env.FC_E2B_BOOTSTRAP_RUNTIME !== "false") {
    runtimeMode = "runtime-bootstrap";
    console.log("installing sandbox-agent 0.4.0 binary");
    await sandbox.commands.run(
      "curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.0/install.sh | sudo SANDBOX_AGENT_VERSION=0.4.0 sh && mkdir -p /home/user/workspace /home/user/.codeagent /tmp/agent && sudo chown -R 1000:1000 /home/user/workspace /home/user/.codeagent /tmp/agent",
      { timeoutMs: 2 * 60 * 1000 },
    );
    version = await sandbox.commands.run("sandbox-agent --version");
  }
  if (!version.stdout.trim()) {
    throw new Error(version.stderr || "sandbox-agent is unavailable");
  }

  await sandbox.commands.run(
    `sandbox-agent server --no-token --host 0.0.0.0 --port ${agentPort} >/tmp/sandbox-agent.log 2>&1`,
    { background: true, timeoutMs: 0 },
  );
  await sandbox.commands.run(
    `for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:${agentPort}/v1/health >/dev/null && exit 0; sleep 1; done; cat /tmp/sandbox-agent.log >&2; exit 1`,
    { timeoutMs: 45_000 },
  );
  console.log("sandbox-agent is healthy inside the sandbox");
  await sandbox.commands.run(
    "mkdir -p /home/user/workspace/preview && printf '%s' '<!doctype html><title>FC E2B Preview</title><h1>fc-e2b-preview-ok</h1>' > /home/user/workspace/preview/index.html",
  );
  await sandbox.commands.run(
    "python3 -m http.server 5173 --bind 0.0.0.0 --directory /home/user/workspace/preview >/tmp/preview.log 2>&1",
    { background: true, timeoutMs: 0 },
  );

  const agentUrl = `https://${sandbox.getHost(agentPort)}/v1/health`;
  const previewUrl = `https://${sandbox.getHost(5173)}/`;
  const accessToken = sandbox.envdAccessToken ?? sandbox.trafficAccessToken;
  const headers = accessToken
    ? { "X-Access-Token": accessToken }
    : {};
  const previewResponse = await waitForHttp(previewUrl, headers);
  const previewBody = await previewResponse.text();
  if (!previewBody.includes("fc-e2b-preview-ok")) {
    throw new Error("preview response did not contain the smoke marker");
  }
  console.log(`preview is reachable through getHost(5173): ${previewResponse.status}`);
  const agentResponse = await waitForHttp(agentUrl, headers);
  console.log(`sandbox-agent and preview are reachable: ${agentResponse.status}/${previewResponse.status}`);
  if (runtimeMode === "runtime-bootstrap") {
    console.log("installing Claude Code 2.1.191 and Claude ACP adapter 0.51.0");
    await sandbox.commands.run(installClaudeCommand, { timeoutMs: 8 * 60 * 1000 });
    console.log("Claude adapter installed");
  }
  const agentClient = await SandboxAgent.connect({
    baseUrl: `https://${sandbox.getHost(agentPort)}`,
    headers,
  });
  const session = await agentClient.createSession({
    agent: "claude",
    cwd: "/home/user/workspace",
  });

  try {
    console.log(
      JSON.stringify(
        {
          sandboxId: sandbox.sandboxId,
          agentSessionId: session.agentSessionId,
          runtimeMode,
          sandboxAgentVersion: version.stdout.trim(),
          sandboxAgentStatus: agentResponse.status,
          agentUrl,
          previewStatus: previewResponse.status,
          previewUrl,
        },
        null,
        2,
      ),
    );
  } finally {
    await agentClient.dispose();
  }
} finally {
  if (process.env.FC_E2B_KEEP_SANDBOX !== "true") {
    await sandbox.kill();
  }
}
