#!/usr/bin/env bash
set -euo pipefail

export WORKSPACE="${WORKSPACE:-/home/user/workspace}"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${CODEAGENT_USER_HOME:-/home/user}/.claude}"
export CODEAGENT_STATE_ROOT="${CODEAGENT_STATE_ROOT:-/home/user/.codeagent}"
export CODEAGENT_USER_HOME="${CODEAGENT_USER_HOME:-/home/user}"
export AGENT_TMP="${AGENT_TMP:-/tmp/agent}"
export FC_OSS_MOUNT_DIR="${FC_OSS_MOUNT_DIR:-}"
export FC_OSS_MOUNT_WAIT_SECONDS="${FC_OSS_MOUNT_WAIT_SECONDS:-30}"
export CODEAGENT_CACHE_ROOT="${CODEAGENT_CACHE_ROOT:-/tmp/codeagent-cache}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$CODEAGENT_CACHE_ROOT/xdg}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$CODEAGENT_CACHE_ROOT/npm}"
export npm_config_store_dir="${npm_config_store_dir:-$CODEAGENT_CACHE_ROOT/pnpm-store}"
export YARN_CACHE_FOLDER="${YARN_CACHE_FOLDER:-$CODEAGENT_CACHE_ROOT/yarn}"
export COREPACK_HOME="${COREPACK_HOME:-$CODEAGENT_CACHE_ROOT/corepack}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$CODEAGENT_CACHE_ROOT/pip}"
export SANDBOX_AGENT_HOST="${SANDBOX_AGENT_HOST:-0.0.0.0}"
export SANDBOX_AGENT_PORT="${SANDBOX_AGENT_PORT:-3001}"
export PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}:/usr/local/bin:/home/user/.npm-global/bin"

export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${DASHSCOPE_API_KEY:-}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://dashscope.aliyuncs.com/apps/anthropic}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-qwen3.7-max}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-qwen3.6-flash}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-qwen3.7-max}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-qwen3.7-max}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-qwen3.7-max}"

can_drop_privileges=false
if [[ "$(id -u)" -eq 0 ]] \
  && command -v setpriv >/dev/null 2>&1 \
  && setpriv --reuid=1000 true >/dev/null 2>&1
then
  can_drop_privileges=true
fi

run_as_agent() {
  if [[ "$can_drop_privileges" == true ]]; then
    setpriv --reuid=1000 "$@"
    return
  fi
  "$@"
}

is_exact_mountpoint() {
  local target="$1"
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q -- "$target"
    return
  fi

  MOUNTPOINT_TARGET="$target" python3 - <<'PY'
import os
from pathlib import Path

target = Path(os.environ["MOUNTPOINT_TARGET"]).resolve(strict=True)
escapes = {"\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\"}
for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
    encoded = line.split()[4]
    mountpoint = encoded
    for escaped, decoded in escapes.items():
        mountpoint = mountpoint.replace(escaped, decoded)
    if Path(mountpoint).resolve(strict=True) == target:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

validate_oss_paths() {
  python3 - <<'PY'
import os
from pathlib import Path

mount = Path(os.environ["FC_OSS_MOUNT_DIR"]).resolve(strict=True)

def resolved(name: str) -> Path:
    raw = Path(os.environ[name])
    if not raw.is_absolute():
        raise SystemExit(f"{name} 必须是绝对路径，当前值：{raw}")
    return raw.resolve(strict=False)

def require_child(name: str) -> None:
    value = resolved(name)
    try:
        relative = value.relative_to(mount)
    except ValueError:
        raise SystemExit(f"{name} 必须位于 FC_OSS_MOUNT_DIR 下：{value} 不在 {mount} 下")
    if relative == Path("."):
        raise SystemExit(f"{name} 不能直接等于 FC_OSS_MOUNT_DIR，必须使用独立子目录")

def require_local(name: str) -> None:
    value = resolved(name)
    try:
        value.relative_to(mount)
    except ValueError:
        return
    raise SystemExit(f"{name} 必须使用沙箱本地目录，不能位于 OSS 挂载点下：{value}")

require_child("CLAUDE_CONFIG_DIR")
require_child("WORKSPACE")

workspace = resolved("WORKSPACE")
claude = resolved("CLAUDE_CONFIG_DIR")
for parent_name, parent, child_name, child in (
    ("WORKSPACE", workspace, "CLAUDE_CONFIG_DIR", claude),
    ("CLAUDE_CONFIG_DIR", claude, "WORKSPACE", workspace),
):
    try:
        child.relative_to(parent)
    except ValueError:
        continue
    raise SystemExit(
        f"{parent_name} 与 {child_name} 必须是 OSS 挂载点下互不重叠的兄弟目录：{parent}，{child}"
    )

require_local("CODEAGENT_STATE_ROOT")
require_local("AGENT_TMP")
require_local("CODEAGENT_CACHE_ROOT")
PY
}

if [[ -n "$FC_OSS_MOUNT_DIR" ]]; then
  if [[ ! "$FC_OSS_MOUNT_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "FC_OSS_MOUNT_WAIT_SECONDS 必须是非负整数" >&2
    exit 64
  fi

  mount_ready=false
  for ((attempt = 0; attempt <= FC_OSS_MOUNT_WAIT_SECONDS; attempt++)); do
    if [[ -d "$FC_OSS_MOUNT_DIR" ]] && is_exact_mountpoint "$FC_OSS_MOUNT_DIR"; then
      mount_ready=true
      break
    fi
    if (( attempt < FC_OSS_MOUNT_WAIT_SECONDS )); then
      sleep 1
    fi
  done

  if [[ "$mount_ready" != true ]]; then
    echo "OSS 挂载未就绪：$FC_OSS_MOUNT_DIR 不是独立挂载点；拒绝在本地空目录启动" >&2
    exit 78
  fi
  validate_oss_paths
fi

mkdir -p "$CODEAGENT_STATE_ROOT" "$AGENT_TMP"
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R 1000:1000 "$CODEAGENT_STATE_ROOT" "$AGENT_TMP"
fi

run_as_agent mkdir -p "$WORKSPACE" "$CLAUDE_CONFIG_DIR" "$CODEAGENT_CACHE_ROOT"
if [[ ! -e "$CLAUDE_CONFIG_DIR/CLAUDE.md" && ! -L "$CLAUDE_CONFIG_DIR/CLAUDE.md" ]]; then
  run_as_agent cp /etc/codeagent/CLAUDE.md "$CLAUDE_CONFIG_DIR/CLAUDE.md"
fi

cd "$WORKSPACE"

SANDBOX_AGENT_BIN="${SANDBOX_AGENT_BIN:-$(command -v sandbox-agent || true)}"
if [[ -z "$SANDBOX_AGENT_BIN" ]]; then
  for candidate in \
    /usr/local/bin/sandbox-agent \
    /home/user/.npm-global/bin/sandbox-agent \
    /usr/local/share/nvm/versions/node/v*/bin/sandbox-agent
  do
    if [[ -x "$candidate" ]]; then
      SANDBOX_AGENT_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$SANDBOX_AGENT_BIN" ]]; then
  echo "sandbox-agent binary not found in PATH=$PATH" >&2
  exit 127
fi

server_env=(
  PATH="$PATH" \
  HOME="$CODEAGENT_USER_HOME" \
  USER=user \
  LOGNAME=user \
  PWD="$WORKSPACE" \
  INIT_CWD="$WORKSPACE" \
  WORKSPACE="$WORKSPACE" \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  CODEAGENT_STATE_ROOT="$CODEAGENT_STATE_ROOT" \
  AGENT_TMP="$AGENT_TMP" \
  FC_OSS_MOUNT_DIR="$FC_OSS_MOUNT_DIR" \
  FC_OSS_MOUNT_WAIT_SECONDS="$FC_OSS_MOUNT_WAIT_SECONDS" \
  CODEAGENT_CACHE_ROOT="$CODEAGENT_CACHE_ROOT" \
  XDG_CACHE_HOME="$XDG_CACHE_HOME" \
  NPM_CONFIG_CACHE="$NPM_CONFIG_CACHE" \
  npm_config_store_dir="$npm_config_store_dir" \
  YARN_CACHE_FOLDER="$YARN_CACHE_FOLDER" \
  COREPACK_HOME="$COREPACK_HOME" \
  PIP_CACHE_DIR="$PIP_CACHE_DIR" \
  ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
  ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  ANTHROPIC_MODEL="$ANTHROPIC_MODEL" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_DEFAULT_HAIKU_MODEL" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_DEFAULT_SONNET_MODEL" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_DEFAULT_OPUS_MODEL" \
  CLAUDE_CODE_SUBAGENT_MODEL="$CLAUDE_CODE_SUBAGENT_MODEL"
)

server_cmd=("$SANDBOX_AGENT_BIN" server --no-token --host "$SANDBOX_AGENT_HOST" --port "$SANDBOX_AGENT_PORT")

if [[ "$can_drop_privileges" == true ]]; then
  exec setpriv --reuid=1000 env "${server_env[@]}" "${server_cmd[@]}"
fi

exec env "${server_env[@]}" "${server_cmd[@]}"
