#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import socket
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


STATE_ROOT = Path(os.getenv("CODEAGENT_STATE_ROOT", "/home/user/.codeagent"))
MANIFEST_PATH = STATE_ROOT / "preview.json"
EXTERNAL_HOST_PROBE = "preview.codeagent.invalid"


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def port_is_ready(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def normalize_health_path(value: str) -> str:
    return value if value.startswith("/") else f"/{value}"


def http_is_ready(port: int, health_path: str, host: str | None = None) -> tuple[bool, str]:
    url = f"http://127.0.0.1:{port}{normalize_health_path(health_path)}"
    try:
        headers = {"Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
        if host:
            headers["Host"] = host
        request = Request(url, headers=headers)
        with urlopen(request, timeout=4) as response:
            response.read(1)
            return 200 <= response.status < 400, f"HTTP {response.status}"
    except HTTPError as error:
        return False, f"HTTP {error.code}"
    except (URLError, OSError) as error:
        return False, str(error)


def command_publish(args: argparse.Namespace) -> int:
    if not port_is_ready(args.port):
        print(f"preview port 127.0.0.1:{args.port} is not accepting connections", flush=True)
        return 1
    healthy, detail = http_is_ready(args.port, args.health_path)
    if not healthy:
        print(f"preview health check failed at 127.0.0.1:{args.port}{normalize_health_path(args.health_path)}: {detail}", flush=True)
        return 1
    externally_healthy, external_detail = http_is_ready(args.port, args.health_path, EXTERNAL_HOST_PROBE)
    if not externally_healthy:
        print(
            "preview server rejected an external Host header "
            f"({external_detail}). For Vite, set server.host='0.0.0.0' and "
            "server.allowedHosts=true; configure the equivalent host allowlist for other dev servers, then publish again.",
            flush=True,
        )
        return 1
    payload = {
        "version": 2,
        "status": "ready",
        "name": args.name,
        "targetHost": "127.0.0.1",
        "targetPort": args.port,
        "healthPath": normalize_health_path(args.health_path),
        "projectRoot": str(Path(args.cwd).resolve()),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if args.start_command:
        payload["startCommand"] = args.start_command
    write_json_atomic(MANIFEST_PATH, payload)
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


def command_clear(_: argparse.Namespace) -> int:
    MANIFEST_PATH.unlink(missing_ok=True)
    return 0


def command_status(_: argparse.Namespace) -> int:
    payload = read_json(MANIFEST_PATH)
    if not payload:
        print(json.dumps({"status": "none"}))
        return 1
    port = int(payload.get("targetPort", 0))
    payload["ready"], payload["health"] = http_is_ready(port, str(payload.get("healthPath", "/")))
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ready"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="codeagent-preview")
    subcommands = parser.add_subparsers(dest="command", required=True)

    publish = subcommands.add_parser("publish", help="Publish an AI-started web server as the current preview")
    publish.add_argument("--port", required=True, type=int, choices=range(3000, 65536))
    publish.add_argument("--cwd", default=os.getcwd())
    publish.add_argument("--name", default="Web Preview")
    publish.add_argument("--health-path", default="/")
    publish.add_argument(
        "--start-command",
        help="Reusable foreground command that starts this preview from --cwd",
    )
    publish.set_defaults(func=command_publish)

    clear = subcommands.add_parser("clear", help="Clear the current preview manifest")
    clear.set_defaults(func=command_clear)

    status = subcommands.add_parser("status", help="Show the current preview and check its port")
    status.set_defaults(func=command_status)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
