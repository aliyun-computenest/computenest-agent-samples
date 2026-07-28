import { readFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_VERSION = "v2";
const RUNTIME_ROOT = `/home/user/.codeagent-runtime/${RUNTIME_VERSION}`;
const RUNTIME_MARKER = `${RUNTIME_ROOT}/.ready`;
const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RuntimeSandbox {
  commands: {
    run(
      command: string,
      options?: { background?: boolean; timeoutMs?: number },
    ): Promise<CommandResult>;
  };
  files: {
    write(path: string, data: string): Promise<unknown>;
  };
}

export async function ensureRuntimeInstalled(
  sandbox: RuntimeSandbox,
  assetsDir: string,
): Promise<void> {
  const probe = await sandbox.commands.run(
    `if test -f ${RUNTIME_MARKER} && command -v sandbox-agent >/dev/null 2>&1 && test -x /usr/local/bin/start-sandbox-agent && test -x /usr/local/bin/codeagent-preview && test -x /home/user/.local/share/sandbox-agent/bin/agent_processes/claude-acp; then printf ready; else printf missing; fi`,
    { timeoutMs: 10_000 },
  );
  if (probe.stdout.trim() === "ready") return;

  // Security boundary: assetsDir is deployment-controlled and only these fixed
  // relative files are loaded; neither paths nor contents may come from user input.
  const [startSandboxAgent, codeagentPreview, claudeInstructions] = await Promise.all([
    readFile(path.join(assetsDir, "bin/start_sandbox_agent.sh"), "utf8"),
    readFile(path.join(assetsDir, "bin/codeagent_preview.py"), "utf8"),
    readFile(path.join(assetsDir, "config/CLAUDE.md"), "utf8"),
  ]);
  const prepare = await sandbox.commands.run(`mkdir -p ${RUNTIME_ROOT}`, {
    timeoutMs: 10_000,
  });
  assertCommandSucceeded(prepare, "prepare CodeAgent runtime directory");

  await Promise.all([
    sandbox.files.write(`${RUNTIME_ROOT}/start-sandbox-agent`, startSandboxAgent),
    sandbox.files.write(`${RUNTIME_ROOT}/codeagent-preview`, codeagentPreview),
    sandbox.files.write(`${RUNTIME_ROOT}/CLAUDE.md`, claudeInstructions),
  ]);

  const install = await sandbox.commands.run(runtimeInstallCommand(), {
    timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS,
  });
  assertCommandSucceeded(install, "install CodeAgent runtime");
}

function runtimeInstallCommand(): string {
  return [
    "set -eu",
    "export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com",
    "export npm_config_registry=https://registry.npmmirror.com",
    "sudo -H env NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY npm_config_registry=$npm_config_registry npm install -g @anthropic-ai/claude-code@2.1.191 @sandbox-agent/cli@0.4.0",
    "sudo mkdir -p /etc/codeagent",
    `sudo install -m 0755 ${RUNTIME_ROOT}/start-sandbox-agent /usr/local/bin/start-sandbox-agent`,
    `sudo install -m 0755 ${RUNTIME_ROOT}/codeagent-preview /usr/local/bin/codeagent-preview`,
    `sudo install -m 0644 ${RUNTIME_ROOT}/CLAUDE.md /etc/codeagent/CLAUDE.md`,
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
    "sandbox-agent install-agent claude --agent-version 2.1.191 --agent-process-version 0.51.0",
    "cleanup",
    "trap - EXIT",
    `touch ${RUNTIME_MARKER}`,
  ].join("\n");
}

function assertCommandSucceeded(result: CommandResult, action: string): void {
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  throw new Error(`${action} failed: ${detail}`);
}
