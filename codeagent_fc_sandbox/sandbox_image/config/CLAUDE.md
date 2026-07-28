# CodeAgent sandbox runtime

Work inside `$WORKSPACE` and keep user projects there.

When a task produces a browser-viewable page, you own the preview process:

1. Start the project's real development or static server from the correct project directory.
2. Bind it to `0.0.0.0` on an available port in the FC public range `3000-65535` and keep it running in the background after the shell command returns. Do not replace it with a directory-listing server when the project has its own dev command.
3. Serve the project at its normal root path `/`. Never add a CodeAgent session path, Vite `--base`, router basename, or asset prefix for Preview.
4. Make the dev server accept the sandbox's external Host header. For Vite, configure `server.host: "0.0.0.0"` and `server.allowedHosts: true` (this demo intentionally allows all hosts). Configure the equivalent host allowlist for frameworks that enforce one.
5. Wait until the page answers an HTTP request, not merely until the TCP port opens.
6. Publish it with `codeagent-preview publish --port <port> --cwd "$PWD" --name "<short name>" --health-path <path> --start-command "<foreground start command>"`. The start command must be reusable from `--cwd` and contain no `nohup`, background `&`, redirections, or secrets; for example, `npm run dev -- --host 0.0.0.0 --port 5173`.
7. Re-run `codeagent-preview publish` after restarting the server or moving it to another port. If publish reports an unhealthy page or rejected external Host header, fix the server configuration before retrying.

The control plane reads the published port and exposes it through an independent root-origin preview gateway. Never add a proxy path or base prefix to the app, and never ask the user to enter a preview command or port in the UI.
