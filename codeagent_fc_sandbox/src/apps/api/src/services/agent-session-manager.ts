import path from "node:path/posix";
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { FcE2BSandboxProvider, isFcSandboxNotFoundError } from "@codeagent-sandbox-demo/fc-e2b-provider";
import {
  BusinessSessionStore,
  FileSessionPersistDriver,
  type BusinessSession,
  type PreviewIntent,
} from "@codeagent-sandbox-demo/core";
import { SandboxAgent, Session, type FsEntry, type SessionEvent } from "sandbox-agent";
import { Agent, fetch as undiciFetch } from "undici";
import type { AppConfig } from "../config.js";
import {
  cancelNativeClaudePrompt,
  isNativeClaudeSessionResourceNotFound,
  resumeOrCreateNativeClaudeSession,
} from "./native-claude-session.js";

const ACP_HEADERS_TIMEOUT_MS = 1_800_000;
const RUNTIME_CLOSE_STEP_TIMEOUT_MS = 5_000;
const PREVIEW_RECOVERY_TIMEOUT_MS = 90_000;
const DEFAULT_SESSION_TITLE = "新的会话";
const MAX_SESSION_TITLE_LENGTH = 28;
const REPLAY_PROMPT_PREFIX = "Previous session history is replayed below";
const PREVIEW_RECOVERY_PROMPT_PREFIX = "[CODEAGENT_INTERNAL_PREVIEW_RECOVERY]";

interface RuntimeHandle {
  sdk: SandboxAgent;
  session?: Session;
  sessionPromise?: Promise<Session>;
}

interface RuntimeEntry {
  readonly generation: symbol;
  readonly promise: Promise<RuntimeHandle>;
}

interface RuntimeUse {
  readonly entry: RuntimeEntry;
  count: number;
}

interface RuntimeLease {
  handle: RuntimeHandle;
  release(): void;
}

interface PreviewRecoveryTask {
  readonly recoveryEpoch: number;
  readonly promise: Promise<void>;
}

export interface AgentSessionManagerDependencies {
  startSandboxAgent?: typeof SandboxAgent.start;
  previewFetch?: typeof fetch;
  previewRecoveryTimeoutMs?: number;
  onSandboxIdChanged?: (sessionId: string, previousSandboxId: string, nextSandboxId: string) => void;
}

export interface WorkspaceSnapshotEntry {
  path: string;
  size: number;
  modified: string;
}

export interface PreviewStatus {
  status: "none" | "starting" | "recovering" | "ready" | "unavailable";
  origin?: string;
  port?: number;
  projectRoot?: string;
  updatedAt?: string;
  healthPath?: string;
  startCommand?: string;
  recoverable?: boolean;
}

export class AgentSessionManager {
  private readonly handles = new Map<string, RuntimeEntry>();
  private readonly handleUsers = new Map<string, RuntimeUse>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly closingRuntimes = new Map<string, Promise<void>>();
  private readonly activePrompts = new Map<string, symbol>();
  private readonly previewRecoveries = new Map<string, PreviewRecoveryTask>();
  private readonly hiddenPreviewRecoveryEvents = new Map<string, number>();
  private readonly deletingSessions = new Set<string>();
  private readonly sandboxDispatcher: Agent;
  private readonly startSandboxAgent: typeof SandboxAgent.start;
  private readonly previewFetch: typeof fetch;
  private readonly previewRecoveryTimeoutMs: number;
  private readonly onSandboxIdChanged?: AgentSessionManagerDependencies["onSandboxIdChanged"];
  private recoveryBarrier: Promise<void> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly provider: FcE2BSandboxProvider,
    private readonly persist: FileSessionPersistDriver,
    private readonly store: BusinessSessionStore,
    dependencies: AgentSessionManagerDependencies = {},
  ) {
    this.sandboxDispatcher = new Agent({
      headersTimeout: ACP_HEADERS_TIMEOUT_MS,
      bodyTimeout: 0,
      connectTimeout: Math.min(config.fc.requestTimeoutMs, 30_000),
    });
    this.startSandboxAgent = dependencies.startSandboxAgent ?? SandboxAgent.start.bind(SandboxAgent);
    this.previewFetch = dependencies.previewFetch ?? fetch;
    this.previewRecoveryTimeoutMs = dependencies.previewRecoveryTimeoutMs ?? PREVIEW_RECOVERY_TIMEOUT_MS;
    this.onSandboxIdChanged = dependencies.onSandboxIdChanged;
  }

  async start(): Promise<void> {
    await this.backfillPlaceholderTitles();
  }

  async prepare(sessionId: string): Promise<BusinessSession> {
    const business = await this.requireCurrentSession(sessionId);
    await this.withRuntime(business, async () => undefined);
    return this.store.require(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.sendMessageAttempt(sessionId, text, true);
  }

  private async sendMessageAttempt(
    sessionId: string,
    text: string,
    allowTransportRetry: boolean,
  ): Promise<void> {
    await this.waitForRecovery();
    const previewRecovery = this.previewRecoveries.get(sessionId);
    if (previewRecovery) {
      const current = await this.store.require(sessionId);
      if (previewRecovery.recoveryEpoch === (current.recoveryEpoch ?? 0)) {
        await previewRecovery.promise;
      } else {
        if (this.previewRecoveries.get(sessionId) === previewRecovery) {
          this.previewRecoveries.delete(sessionId);
        }
        if (this.hiddenPreviewRecoveryEvents.get(sessionId) === previewRecovery.recoveryEpoch) {
          this.hiddenPreviewRecoveryEvents.delete(sessionId);
        }
      }
    }
    if (this.activePrompts.has(sessionId)) {
      throw new Error("session is already running a prompt");
    }
    const promptToken = Symbol(`prompt:${sessionId}`);
    this.activePrompts.set(sessionId, promptToken);

    let lease: RuntimeLease | undefined;
    try {
      const business = await this.requireCurrentSession(sessionId);
      await this.setInitialTitle(sessionId, text);
      lease = await this.acquireRuntime(business);
      const session = await this.claudeSessionForPrompt(sessionId, promptToken, lease.handle);
      await this.store.update(sessionId, (current) => {
        this.assertPromptCurrent(sessionId, promptToken, current);
        return {
          ...current,
          status: "running",
          claudeSessionPrompted: true,
          error: undefined,
        };
      });

      void this.runPrompt(sessionId, text, promptToken, session, lease);
    } catch (error) {
      if (this.isPromptCurrent(sessionId, promptToken)) {
        await this.store.update(sessionId, (current) => {
          if (this.isTerminal(current)) return undefined;
          return {
            ...current,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }).catch(() => undefined);
        this.activePrompts.delete(sessionId);
      }
      lease?.release();
      if (isAcpTransportFailure(error)) {
        await this.recoverTransportFailure(error);
        // runPrompt 尚未启动，用户消息还没有提交给模型。此时可以安全地
        // 在清除旧 Runtime 后重试一次，让被回收的沙箱透明切换到 replacement。
        if (allowTransportRetry) {
          await this.sendMessageAttempt(sessionId, text, false);
          return;
        }
      }
      throw error;
    }
  }

  async recoverTransportFailure(error: unknown): Promise<void> {
    if (this.recoveryBarrier) return this.recoveryBarrier;
    const recovery = this.performTransportRecovery(error);
    this.recoveryBarrier = recovery;
    try {
      await recovery;
    } finally {
      if (this.recoveryBarrier === recovery) this.recoveryBarrier = undefined;
    }
  }

  async close(): Promise<void> {
    await this.waitForRecovery();
    await Promise.allSettled(
      [...this.previewRecoveries.values()].map((recovery) =>
        settleWithin(recovery.promise, RUNTIME_CLOSE_STEP_TIMEOUT_MS)),
    );
    const handles = [...this.handles.entries()];
    const activePrompts = new Set(this.activePrompts.keys());
    this.clearAllIdleTimers();
    this.handles.clear();
    this.handleUsers.clear();
    this.activePrompts.clear();
    this.hiddenPreviewRecoveryEvents.clear();
    await Promise.allSettled(
      [...activePrompts].map((sessionId) => this.store.update(sessionId, (current) => {
        if (this.isTerminal(current)) return undefined;
        return {
          ...current,
          status: "failed",
          error: "Backend stopped while the Claude prompt was running",
        };
      })),
    );
    const closing = handles.map(([sessionId, entry]) =>
      this.beginRuntimeClose(sessionId, entry, activePrompts.has(sessionId)));
    await Promise.allSettled(
      [...this.closingRuntimes.values(), ...closing].map((promise) =>
        settleWithin(promise, RUNTIME_CLOSE_STEP_TIMEOUT_MS)),
    );
    // Graceful close can wait forever behind an in-flight ACP request. At process
    // shutdown all handles are already detached, so force the dispatcher closed.
    await this.sandboxDispatcher.destroy();
  }

  async listEvents(sessionId: string, afterIndex: number): Promise<SessionEvent[]> {
    await this.requireCurrentSession(sessionId);
    const events: SessionEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.persist.listEvents({ sessionId, cursor, limit: 500 });
      events.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return filterInternalPreviewRecoveryEvents(events)
      .filter((event) => event.eventIndex > afterIndex);
  }

  subscribeEvents(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const shouldShow = createInternalPreviewRecoveryEventFilter();
    return this.persist.subscribe(sessionId, (event) => {
      if (shouldShow(event)) listener(event);
    });
  }

  async listFiles(sessionId: string, relativePath = ""): Promise<FsEntry[]> {
    const business = await this.requireCurrentSession(sessionId);
    return this.withRuntime(business, ({ sdk }) => sdk.listFsEntries({ path: this.workspacePath(business.workspaceRoot, relativePath) }));
  }

  async readFile(sessionId: string, relativePath: string): Promise<Uint8Array> {
    const business = await this.requireCurrentSession(sessionId);
    return this.withRuntime(business, ({ sdk }) => sdk.readFsFile({ path: this.workspacePath(business.workspaceRoot, relativePath) }));
  }

  async writeFile(sessionId: string, relativePath: string, body: BodyInit): Promise<unknown> {
    const business = await this.requireCurrentSession(sessionId);
    return this.withRuntime(business, ({ sdk }) => sdk.writeFsFile({ path: this.workspacePath(business.workspaceRoot, relativePath) }, body));
  }

  async workspaceSnapshot(sessionId: string): Promise<WorkspaceSnapshotEntry[]> {
    const business = await this.requireCurrentSession(sessionId);
    return this.withRuntime(business, async ({ sdk }) => {
      const result = await sdk.runProcess({
        command: "sh",
        args: [
          "-lc",
          "find . \\( -path './.git' -o -path '*/node_modules' -o -path '*/dist' -o -path '*/build' -o -path '*/.next' -o -path '*/.venv' \\) -prune -o -type f -printf '%P\\t%s\\t%T@\\n' | sort | head -2000",
        ],
        cwd: business.workspaceRoot,
        timeoutMs: this.provider.usesOss ? 30_000 : 10_000,
        maxOutputBytes: 512_000,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || "failed to inspect workspace");
      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [filePath, size, modified] = line.split("\t");
          return { path: filePath, size: Number(size), modified };
        })
        .filter((entry) => entry.path && Number.isFinite(entry.size));
    });
  }

  async getPreviewStatus(sessionId: string): Promise<PreviewStatus> {
    const business = await this.requireCurrentSession(sessionId);
    const status = await this.withRuntime(business, ({ sdk }) => this.probePreviewStatus(sessionId, sdk));
    const latest = await this.store.require(sessionId);
    const recoveryEpoch = latest.recoveryEpoch ?? 0;

    if (status.status === "ready" && status.port && status.projectRoot) {
      const healthPath = status.healthPath ?? "/";
      await this.store.update(sessionId, (current) => ({
        ...current,
        previewIntent: {
          desired: true,
          projectRoot: status.projectRoot!,
          port: status.port!,
          healthPath,
          startCommand: status.startCommand ?? current.previewIntent?.startCommand,
          lastReadyAt: new Date().toISOString(),
          recoveryEpoch: current.recoveryEpoch ?? 0,
          recoveryStatus: "ready",
        },
      }));
      return withoutInternalPreviewFields(status);
    }

    const intent = latest.previewIntent;
    if (status.recoverable === false) return withoutInternalPreviewFields(status);
    if (!intent?.desired) return withoutInternalPreviewFields(status);
    const attemptedThisEpoch = intent.recoveryEpoch === recoveryEpoch;
    if (attemptedThisEpoch && intent.recoveryStatus === "failed") {
      return previewStatusFromIntent("unavailable", intent);
    }
    const previewRecovery = this.previewRecoveries.get(sessionId);
    if (
      (attemptedThisEpoch && (intent.recoveryStatus === "running" || intent.recoveryStatus === "pending"))
      || previewRecovery?.recoveryEpoch === recoveryEpoch
    ) {
      return previewStatusFromIntent("recovering", intent);
    }
    if (this.schedulePreviewRecovery(sessionId, recoveryEpoch)) {
      return previewStatusFromIntent("recovering", intent);
    }
    return withoutInternalPreviewFields(status);
  }

  private async probePreviewStatus(sessionId: string, sdk: SandboxAgent): Promise<PreviewStatus> {
    let manifest: Record<string, unknown>;
    try {
      const bytes = await sdk.readFsFile({ path: path.join(this.config.agentStateRoot, "preview.json") });
      manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    } catch {
      return { status: "none", recoverable: true };
    }

    const port = Number(manifest.targetPort);
    if (!Number.isInteger(port) || port < 3_000 || port > 65_535) {
      return { status: "unavailable", recoverable: false };
    }
    const healthPath = typeof manifest.healthPath === "string" && manifest.healthPath.startsWith("/")
      ? manifest.healthPath
      : "/";
    const startCommand = typeof manifest.startCommand === "string"
      && manifest.startCommand.trim().length > 0
      && manifest.startCommand.length <= 16_384
      ? manifest.startCommand
      : undefined;
    const latest = await this.store.require(sessionId);
    if (!latest.sandboxId) return { status: "starting", port, healthPath };

    const origin = await this.provider.getPortUrl(latest.sandboxId, port);
    const status: PreviewStatus = {
      status: "starting",
      origin,
      port,
      healthPath,
      startCommand,
      projectRoot: typeof manifest.projectRoot === "string" ? manifest.projectRoot : undefined,
      updatedAt: typeof manifest.updatedAt === "string" ? manifest.updatedAt : undefined,
    };
    try {
      const response = await this.previewFetch(new URL(healthPath, `${origin}/`), {
        headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(4_000),
      });
      await response.body?.cancel();
      return response.ok
        ? { ...status, status: "ready" }
        : { ...status, status: "unavailable", recoverable: true };
    } catch {
      return { ...status, status: "unavailable", recoverable: true };
    }
  }

  private schedulePreviewRecovery(sessionId: string, recoveryEpoch: number): boolean {
    const existing = this.previewRecoveries.get(sessionId);
    if (existing?.recoveryEpoch === recoveryEpoch) return true;
    if (this.activePrompts.has(sessionId)) return false;

    let task: PreviewRecoveryTask;
    const promise = Promise.resolve()
      .then(() => this.runPreviewRecovery(sessionId, recoveryEpoch))
      .catch(async (error: unknown) => {
        await this.markPreviewRecoveryFailed(sessionId, recoveryEpoch, error);
        if (isAcpTransportFailure(error)) await this.recoverTransportFailure(error);
      })
      .finally(() => {
        if (this.previewRecoveries.get(sessionId) === task) this.previewRecoveries.delete(sessionId);
        if (this.hiddenPreviewRecoveryEvents.get(sessionId) === recoveryEpoch) {
          this.hiddenPreviewRecoveryEvents.delete(sessionId);
        }
      });
    task = { recoveryEpoch, promise };
    this.previewRecoveries.set(sessionId, task);
    return true;
  }

  private async runPreviewRecovery(sessionId: string, recoveryEpoch: number): Promise<void> {
    const owner = await this.store.require(sessionId);
    if (!owner.previewIntent?.desired || (owner.recoveryEpoch ?? 0) !== recoveryEpoch) return;
    await this.store.update(sessionId, (current) => {
      if (!current.previewIntent?.desired || (current.recoveryEpoch ?? 0) !== recoveryEpoch) return undefined;
      return {
        ...current,
        previewIntent: {
          ...current.previewIntent,
          recoveryEpoch,
          recoveryStatus: "running",
          recoveryError: undefined,
        },
      };
    });

    const lease = await this.acquireRuntime(owner);
    try {
      const latest = await this.store.require(sessionId);
      const intent = latest.previewIntent;
      if (!intent?.desired || (latest.recoveryEpoch ?? 0) !== recoveryEpoch) return;
      let status = intent.startCommand
        ? await this.restartPreviewFromIntent(sessionId, lease.handle.sdk, latest.workspaceRoot, intent)
          .catch(() => undefined)
        : undefined;

      if (!status) {
        const session = lease.handle.session;
        if (!session) throw new Error("Preview 自动恢复需要已经持久化的 Claude 会话");

        this.hiddenPreviewRecoveryEvents.set(sessionId, recoveryEpoch);
        try {
          try {
            await rejectAfter(
              session.prompt([{
                type: "text",
                text: buildPreviewRecoveryPrompt(intent),
              }]),
              this.previewRecoveryTimeoutMs,
              new PreviewRecoveryTimeoutError(this.previewRecoveryTimeoutMs),
            );
          } catch (error) {
            if (error instanceof PreviewRecoveryTimeoutError) {
              await settleWithin(
                cancelNativeClaudePrompt(lease.handle.sdk, session).catch(() => undefined),
                RUNTIME_CLOSE_STEP_TIMEOUT_MS,
              );
            }
            throw error;
          }
        } finally {
          if (this.hiddenPreviewRecoveryEvents.get(sessionId) === recoveryEpoch) {
            this.hiddenPreviewRecoveryEvents.delete(sessionId);
          }
        }

        status = await this.probePreviewStatus(sessionId, lease.handle.sdk);
        if (status.status !== "ready" || !status.port) {
          throw new Error("AI 已完成恢复任务，但 Preview 服务仍未通过健康检查");
        }
      }
      await this.store.update(sessionId, (current) => {
        if (!current.previewIntent?.desired || (current.recoveryEpoch ?? 0) !== recoveryEpoch) return undefined;
        return {
          ...current,
          previewIntent: {
            ...current.previewIntent,
            projectRoot: status.projectRoot ?? current.previewIntent.projectRoot,
            port: status.port!,
            healthPath: status.healthPath ?? current.previewIntent.healthPath,
            startCommand: status.startCommand ?? current.previewIntent.startCommand,
            lastReadyAt: new Date().toISOString(),
            recoveryEpoch,
            recoveryStatus: "ready",
            recoveryError: undefined,
          },
        };
      });
    } finally {
      lease.release();
    }
  }

  private async restartPreviewFromIntent(
    sessionId: string,
    sdk: SandboxAgent,
    workspaceRoot: string,
    intent: PreviewIntent,
  ): Promise<PreviewStatus | undefined> {
    if (!intent.startCommand) return undefined;
    const projectRoot = this.workspacePath(workspaceRoot, intent.projectRoot);
    const logPath = `/tmp/codeagent-preview-${intent.port}.log`;
    const publishCommand = [
      "codeagent-preview publish",
      `--port ${intent.port}`,
      `--cwd ${shellQuote(projectRoot)}`,
      `--name ${shellQuote("Web Preview")}`,
      `--health-path ${shellQuote(intent.healthPath)}`,
      `--start-command ${shellQuote(intent.startCommand)}`,
    ].join(" ");
    const script = [
      `if ${publishCommand}; then exit 0; fi`,
      `nohup sh -lc ${shellQuote(intent.startCommand)} >${shellQuote(logPath)} 2>&1 </dev/null &`,
      "attempt=0",
      `until ${publishCommand}; do`,
      "  attempt=$((attempt + 1))",
      "  if [ \"$attempt\" -ge 30 ]; then",
      `    tail -n 80 ${shellQuote(logPath)} >&2 || true`,
      "    exit 1",
      "  fi",
      "  sleep 1",
      "done",
    ].join("\n");
    const result = await sdk.runProcess({
      command: "sh",
      args: ["-lc", script],
      cwd: projectRoot,
      timeoutMs: 40_000,
      maxOutputBytes: 128_000,
    });
    if (result.exitCode !== 0) return undefined;
    const status = await this.probePreviewStatus(sessionId, sdk);
    return status.status === "ready" && status.port ? status : undefined;
  }

  private async markPreviewRecoveryFailed(sessionId: string, recoveryEpoch: number, error: unknown): Promise<void> {
    await this.store.update(sessionId, (current) => {
      if (!current.previewIntent?.desired || (current.recoveryEpoch ?? 0) !== recoveryEpoch) return undefined;
      return {
        ...current,
        previewIntent: {
          ...current.previewIntent,
          recoveryEpoch,
          recoveryStatus: "failed",
          recoveryError: error instanceof Error ? error.message : String(error),
        },
      };
    }).catch(() => undefined);
  }

  async deleteSession(sessionId: string): Promise<BusinessSession> {
    await this.waitForRecovery();
    const business = await this.store.require(sessionId);
    this.assertCurrentRuntime(business);
    this.deletingSessions.add(sessionId);
    const hadActivePrompt = this.activePrompts.delete(sessionId);
    const deleting = await this.store.update(sessionId, (current) => ({
      ...current,
      status: "deleting",
      error: undefined,
    }));
    try {
      await this.disposeRuntime(sessionId, hadActivePrompt);

      // createRuntime may have learned an ID while deletion was waiting. Always
      // re-read before destroying both the official and pending resources.
      const latest = await this.store.require(sessionId);
      const sandboxIds = new Set(
        [latest.sandboxId, latest.pendingSandboxId, deleting.sandboxId, deleting.pendingSandboxId].filter(
          (value): value is string => Boolean(value),
        ),
      );
      await Promise.all([...sandboxIds].map((sandboxId) => this.destroySandboxIgnoringMissing(sandboxId)));
      return await this.store.update(sessionId, (current) => ({
        ...current,
        status: "deleted",
        pendingSandboxId: undefined,
        error: undefined,
      }));
    } catch (error) {
      await this.store.update(sessionId, (current) => ({
        ...current,
        status: "delete_failed",
        error: `sandbox deletion failed: ${error instanceof Error ? error.message : String(error)}`,
      })).catch(() => undefined);
      throw error;
    } finally {
      this.deletingSessions.delete(sessionId);
    }
  }

  private async withRuntime<T>(business: BusinessSession, action: (handle: RuntimeHandle) => Promise<T>): Promise<T> {
    const lease = await this.acquireRuntime(business);
    try {
      return await action(lease.handle);
    } catch (error) {
      if (isAcpTransportFailure(error)) await this.recoverTransportFailure(error);
      throw error;
    } finally {
      lease.release();
    }
  }

  private async acquireRuntime(business: BusinessSession): Promise<RuntimeLease> {
    await this.waitForRecovery();
    this.assertCurrentRuntime(business);
    this.assertUsableSession(business);
    this.clearIdleTimer(business.id);
    const { entry, handle } = await this.runtimeFor(business);
    this.clearIdleTimer(business.id);
    const currentUse = this.handleUsers.get(business.id);
    if (currentUse?.entry === entry) {
      currentUse.count += 1;
    } else {
      this.handleUsers.set(business.id, { entry, count: 1 });
    }
    let released = false;
    return {
      handle,
      release: () => {
        if (released) return;
        released = true;
        const use = this.handleUsers.get(business.id);
        if (!use || use.entry !== entry) return;
        const remaining = Math.max(0, use.count - 1);
        if (remaining === 0) {
          this.handleUsers.delete(business.id);
          this.scheduleIdleDispose(business.id, entry);
        } else {
          use.count = remaining;
        }
      },
    };
  }

  private async runtimeFor(business: BusinessSession): Promise<{ entry: RuntimeEntry; handle: RuntimeHandle }> {
    await this.waitForRuntimeClose(business.id);
    let entry = this.handles.get(business.id);
    if (!entry) {
      const generation = Symbol(`runtime:${business.id}`);
      const promise = Promise.resolve().then(() => this.createRuntime(business, generation)).catch((error) => {
        if (this.handles.get(business.id)?.generation === generation) this.handles.delete(business.id);
        throw error;
      });
      entry = { generation, promise };
      this.handles.set(business.id, entry);
    }

    const handle = await entry.promise;
    if (this.handles.get(business.id) !== entry) {
      await handle.sdk.dispose().catch(() => undefined);
      throw new Error(`session '${business.id}' runtime was invalidated while connecting`);
    }
    return { entry, handle };
  }

  private async createRuntime(business: BusinessSession, generation: symbol): Promise<RuntimeHandle> {
    let sdk: SandboxAgent | undefined;
    let sandboxId: string | undefined;
    let cleanupSandboxId: string | undefined;
    try {
      if (this.provider.usesOss && !business.ossPrefix) {
        throw new Error(
          `session '${business.id}' predates OSS persistence and has no isolated OSS prefix; create a new session`,
        );
      }
      if (this.provider.usesOss) {
        if (!business.claudeConfigDir) {
          throw new Error(`session '${business.id}' has no persisted Claude config path; create a new session`);
        }
        if (
          business.workspaceRoot !== this.config.workspaceRoot
          || business.claudeConfigDir !== this.config.claudeConfigDir
        ) {
          throw new Error(
            `session '${business.id}' uses an incompatible OSS layout (${business.workspaceRoot}, ${business.claudeConfigDir}); current layout is (${this.config.workspaceRoot}, ${this.config.claudeConfigDir}); create a new session`,
          );
        }
      }
      let candidateSandboxId = business.pendingSandboxId ?? business.sandboxId;
      let candidateProviderId = business.pendingSandboxId
        ? `${this.provider.name}/${business.pendingSandboxId}`
        : business.sandboxProviderId ??
          (business.sandboxId ? `${this.provider.name}/${business.sandboxId}` : undefined);

      if (!candidateProviderId && this.provider.usesOss) {
        candidateSandboxId = await this.provisionSessionSandbox(business.id, generation);
        candidateProviderId = `${this.provider.name}/${candidateSandboxId}`;
        cleanupSandboxId = candidateSandboxId;
      } else if (business.pendingSandboxId) {
        cleanupSandboxId = business.pendingSandboxId;
      }

      try {
        sdk = await this.startRuntimeSdk(candidateProviderId);
      } catch (error) {
        if (!candidateSandboxId || !isFcSandboxNotFoundError(error)) throw error;
        if (this.provider.usesOss) {
          candidateSandboxId = await this.provisionSessionSandbox(business.id, generation);
          candidateProviderId = `${this.provider.name}/${candidateSandboxId}`;
          cleanupSandboxId = candidateSandboxId;
          sdk = await this.startRuntimeSdk(candidateProviderId);
        } else if (await this.canDiscardMissingSandbox(business.id)) {
          await this.clearMissingSandboxIdentity(business.id, generation, candidateSandboxId);
          candidateSandboxId = undefined;
          candidateProviderId = undefined;
          cleanupSandboxId = undefined;
          sdk = await this.startRuntimeSdk();
        } else {
          throw error;
        }
      }

      const mappedProviderId = sdk.sandboxId;
      if (!mappedProviderId?.startsWith(`${this.provider.name}/`)) {
        throw new Error(`sandbox-agent returned an invalid FC provider ID: ${String(mappedProviderId)}`);
      }
      sandboxId = mappedProviderId.slice(this.provider.name.length + 1);
      if (!sandboxId) throw new Error("sandbox-agent returned an empty FC sandbox ID");
      if (candidateSandboxId && candidateSandboxId !== sandboxId) {
        throw new Error(
          `FC sandbox identity changed while connecting: expected '${candidateSandboxId}', got '${sandboxId}'`,
        );
      }
      if (!business.sandboxId && sandboxId) cleanupSandboxId ??= sandboxId;
      let runtimeWasTerminated = false;
      await this.store.update(business.id, (current) => {
        this.assertRuntimeGenerationCurrent(business.id, generation);
        runtimeWasTerminated = this.deletingSessions.has(business.id) || this.isTerminal(current);
        if (runtimeWasTerminated) return undefined;
        return {
          ...current,
          status: "creating",
          error: undefined,
        };
      });
      if (runtimeWasTerminated) {
        throw new Error(`session '${business.id}' was deleted while its runtime was connecting`);
      }

      this.assertRuntimeGenerationCurrent(business.id, generation);
      await this.bootstrapWorkspace(sdk, business.workspaceRoot);
      this.assertRuntimeGenerationCurrent(business.id, generation);
      const sessionOwner = await this.store.require(business.id);
      this.assertUsableSession(sessionOwner);
      const persistedClaudeSession = await this.persist.getSession(business.id);
      let session: Session | undefined;
      if (sessionOwner.agentSessionId || persistedClaudeSession) {
        try {
          session = await resumeOrCreateNativeClaudeSession({
            sdk,
            persist: this.persist,
            id: business.id,
            agentSessionId: sessionOwner.agentSessionId,
            cwd: sessionOwner.workspaceRoot,
            model: this.config.claude.sessionModel,
            mode: this.config.claude.mode,
          });
        } catch (error) {
          if (
            !isNativeClaudeSessionResourceNotFound(error)
            || !(await this.isProvisionalClaudeSession(sessionOwner))
          ) {
            throw error;
          }
          await this.clearProvisionalClaudeSession(sessionOwner);
        }
        this.assertRuntimeGenerationCurrent(business.id, generation);
        if (session) this.acceptPermissions(session);
      }

      let claudeWasTerminated = false;
      let previousSandboxId: string | undefined;
      await this.store.update(business.id, (current) => {
        this.assertRuntimeGenerationCurrent(business.id, generation);
        claudeWasTerminated = this.deletingSessions.has(business.id) || this.isTerminal(current);
        if (claudeWasTerminated) return undefined;
        if (current.pendingSandboxId && current.pendingSandboxId !== sandboxId) {
          throw new Error(
            `session '${business.id}' pending sandbox changed during recovery: '${current.pendingSandboxId}'`,
          );
        }
        previousSandboxId = current.sandboxId;
        return {
          ...current,
          status: "ready",
          sandboxProviderId: mappedProviderId,
          sandboxId,
          pendingSandboxId: undefined,
          agentSessionId: session?.agentSessionId ?? current.agentSessionId,
          error: undefined,
        };
      });
      if (claudeWasTerminated) {
        throw new Error(`session '${business.id}' was deleted while its Claude session was connecting`);
      }
      if (previousSandboxId && previousSandboxId !== sandboxId) {
        try {
          this.onSandboxIdChanged?.(business.id, previousSandboxId, sandboxId);
        } catch (callbackError) {
          console.error(`[agent-session-manager] sandbox change callback failed for '${business.id}'`, callbackError);
        }
      }
      cleanupSandboxId = undefined;
      return { sdk, session };
    } catch (error) {
      if (sdk) await sdk.dispose().catch(() => undefined);
      const cleanupError = await this.destroyUnclaimedSandbox(business, cleanupSandboxId ?? sandboxId);
      if (this.isRuntimeGenerationCurrent(business.id, generation)) {
        await this.store.update(business.id, (current) => {
          if (this.deletingSessions.has(business.id) || this.isTerminal(current)) return undefined;
          return {
            ...current,
            status: "failed",
            error: cleanupError
              ? `${error instanceof Error ? error.message : String(error)}; candidate sandbox cleanup failed and pendingSandboxId was retained: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
              : error instanceof Error ? error.message : String(error),
          };
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async startRuntimeSdk(sandboxProviderId?: string): Promise<SandboxAgent> {
    return this.startSandboxAgent({
      sandbox: this.provider,
      sandboxId: sandboxProviderId,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: this.sandboxDispatcher,
        }) as unknown as Promise<Response>) as typeof fetch,
      persist: this.persist,
    });
  }

  private async provisionSessionSandbox(sessionId: string, generation: symbol): Promise<string> {
    this.assertRuntimeGenerationCurrent(sessionId, generation);
    const owner = await this.store.require(sessionId);
    this.assertUsableSession(owner);
    if (!owner.ossPrefix) {
      throw new Error(`session '${sessionId}' has no OSS prefix and cannot create a persistent FC sandbox`);
    }

    const sandboxId = await this.provider.createForSession({ ossPrefix: owner.ossPrefix });
    let claimed = false;
    try {
      await this.store.update(sessionId, (current) => {
        this.assertRuntimeGenerationCurrent(sessionId, generation);
        if (this.deletingSessions.has(sessionId) || this.isTerminal(current)) return undefined;
        claimed = true;
        return {
          ...current,
          status: "creating",
          pendingSandboxId: sandboxId,
          recoveryEpoch: (current.recoveryEpoch ?? 0) + 1,
          error: undefined,
        };
      });
      if (!claimed) throw new Error(`session '${sessionId}' was deleted while provisioning its FC sandbox`);
      return sandboxId;
    } catch (error) {
      await this.destroySandboxIgnoringMissing(sandboxId).catch(() => undefined);
      throw error;
    }
  }

  private async bootstrapWorkspace(sdk: SandboxAgent, workspaceRoot: string): Promise<void> {
    await sdk.runProcess({
      command: "sh",
      args: [
        "-lc",
        [
          `mkdir -p ${shellQuote(workspaceRoot)}`,
          `cd ${shellQuote(workspaceRoot)}`,
          "git init >/dev/null 2>&1 || true",
          "git config user.email codeagent@example.local >/dev/null 2>&1 || true",
          "git config user.name codeagent >/dev/null 2>&1 || true",
          "git rev-parse --verify HEAD >/dev/null 2>&1 || git commit --allow-empty -m baseline >/dev/null 2>&1 || true",
        ].join(" && "),
      ],
      timeoutMs: 120_000,
      maxOutputBytes: 64_000,
    });
  }

  private async requireCurrentSession(sessionId: string): Promise<BusinessSession> {
    await this.waitForRecovery();
    const business = await this.store.require(sessionId);
    this.assertCurrentRuntime(business);
    this.assertUsableSession(business);
    return business;
  }

  private assertCurrentRuntime(business: BusinessSession): void {
    if (business.runtimeProvider !== "fc-e2b") {
      throw new Error(`session '${business.id}' belongs to an unsupported legacy runtime; create a new FC session`);
    }
  }

  private assertUsableSession(business: BusinessSession): void {
    if (this.deletingSessions.has(business.id) || this.isTerminal(business)) {
      throw new Error(`session '${business.id}' is ${business.status} and cannot be used`);
    }
  }

  private isTerminal(business: BusinessSession): boolean {
    return business.status === "deleting"
      || business.status === "delete_failed"
      || business.status === "deleted"
      || business.status === "terminated";
  }

  private isPromptCurrent(sessionId: string, token: symbol): boolean {
    return this.activePrompts.get(sessionId) === token;
  }

  private assertPromptCurrent(sessionId: string, token: symbol, business: BusinessSession): void {
    if (!this.isPromptCurrent(sessionId, token)) {
      throw new Error(`session '${sessionId}' prompt was superseded while connecting`);
    }
    this.assertUsableSession(business);
  }

  private async claudeSessionForPrompt(
    sessionId: string,
    promptToken: symbol,
    handle: RuntimeHandle,
  ): Promise<Session> {
    if (handle.session) return handle.session;
    let initializing = handle.sessionPromise;
    if (!initializing) {
      initializing = this.initializeClaudeSession(sessionId, promptToken, handle.sdk);
      handle.sessionPromise = initializing;
    }
    try {
      const session = await initializing;
      if (handle.sessionPromise === initializing) {
        handle.session = session;
        handle.sessionPromise = undefined;
      }
      return session;
    } catch (error) {
      if (handle.sessionPromise === initializing) handle.sessionPromise = undefined;
      throw error;
    }
  }

  private async initializeClaudeSession(
    sessionId: string,
    promptToken: symbol,
    sdk: SandboxAgent,
  ): Promise<Session> {
    let owner = await this.store.require(sessionId);
    this.assertPromptCurrent(sessionId, promptToken, owner);
    let existingIdentity = Boolean(owner.agentSessionId || await this.persist.getSession(sessionId));
    let session: Session;
    try {
      session = await resumeOrCreateNativeClaudeSession({
        sdk,
        persist: this.persist,
        id: sessionId,
        agentSessionId: owner.agentSessionId,
        cwd: owner.workspaceRoot,
        model: this.config.claude.sessionModel,
        mode: this.config.claude.mode,
      });
    } catch (error) {
      if (!isNativeClaudeSessionResourceNotFound(error) || !(await this.isProvisionalClaudeSession(owner))) {
        throw error;
      }
      await this.clearProvisionalClaudeSession(owner);
      owner = await this.store.require(sessionId);
      this.assertPromptCurrent(sessionId, promptToken, owner);
      existingIdentity = false;
      session = await resumeOrCreateNativeClaudeSession({
        sdk,
        persist: this.persist,
        id: sessionId,
        cwd: owner.workspaceRoot,
        model: this.config.claude.sessionModel,
        mode: this.config.claude.mode,
      });
    }

    this.acceptPermissions(session);
    await this.store.update(sessionId, (current) => {
      this.assertPromptCurrent(sessionId, promptToken, current);
      if (current.agentSessionId && current.agentSessionId !== session.agentSessionId) {
        throw new Error(`业务会话 '${sessionId}' 的 Claude agentSessionId 在初始化期间发生变化`);
      }
      return {
        ...current,
        agentSessionId: session.agentSessionId,
        claudeSessionDurable: existingIdentity ? current.claudeSessionDurable : false,
        claudeSessionPrompted: existingIdentity ? current.claudeSessionPrompted : false,
        error: undefined,
      };
    });
    return session;
  }

  private acceptPermissions(session: Session): void {
    session.onPermissionRequest((request) => {
      void session.respondPermission(request.id, "always").catch(() => undefined);
    });
  }

  private async isProvisionalClaudeSession(business: BusinessSession): Promise<boolean> {
    if (business.claudeSessionDurable === true) return false;
    if (await this.hasCompletedClaudePrompt(business.id)) return false;

    let cursor: string | undefined;
    let sawSessionNew = false;
    let sawSessionPrompt = false;
    do {
      const page = await this.persist.listEvents({ sessionId: business.id, cursor, limit: 200 });
      for (const event of page.items) {
        if (event.sender !== "client") continue;
        const method = (event.payload as { method?: unknown }).method;
        if (method === "session/prompt") sawSessionPrompt = true;
        if (method === "session/new") sawSessionNew = true;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return business.claudeSessionDurable === false
      || business.claudeSessionPrompted === true
      || sawSessionNew
      || sawSessionPrompt;
  }

  private async canDiscardMissingSandbox(sessionId: string): Promise<boolean> {
    const business = await this.store.require(sessionId);
    if (business.claudeSessionDurable === true || business.claudeSessionPrompted === true) return false;

    let cursor: string | undefined;
    do {
      const page = await this.persist.listEvents({ sessionId, cursor, limit: 200 });
      for (const event of page.items) {
        if (event.sender !== "client") continue;
        const method = (event.payload as { method?: unknown }).method;
        if (method === "session/prompt") return false;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return true;
  }

  private async hasCompletedClaudePrompt(sessionId: string): Promise<boolean> {
    const promptIds = new Set<string>();
    const responseIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.persist.listEvents({ sessionId, cursor, limit: 200 });
      for (const event of page.items) {
        const payload = event.payload as {
          id?: unknown;
          method?: unknown;
          result?: unknown;
          error?: unknown;
        };
        const id = rpcId(payload.id);
        if (!id) continue;
        if (event.sender === "client" && payload.method === "session/prompt") {
          promptIds.add(id);
        } else if (
          event.sender === "agent"
          && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))
        ) {
          responseIds.add(id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return [...promptIds].some((id) => responseIds.has(id));
  }

  private async clearMissingSandboxIdentity(
    sessionId: string,
    generation: symbol,
    missingSandboxId: string,
  ): Promise<void> {
    await this.store.update(sessionId, (current) => {
      this.assertRuntimeGenerationCurrent(sessionId, generation);
      if (this.deletingSessions.has(sessionId) || this.isTerminal(current)) return undefined;
      if (current.sandboxId !== missingSandboxId && current.pendingSandboxId !== missingSandboxId) return undefined;
      return {
        ...current,
        sandboxId: current.sandboxId === missingSandboxId ? undefined : current.sandboxId,
        sandboxProviderId: current.sandboxId === missingSandboxId ? undefined : current.sandboxProviderId,
        pendingSandboxId: current.pendingSandboxId === missingSandboxId ? undefined : current.pendingSandboxId,
        recoveryEpoch: (current.recoveryEpoch ?? 0) + 1,
        error: undefined,
      };
    });
  }

  private async clearProvisionalClaudeSession(business: BusinessSession): Promise<void> {
    await this.persist.deleteSessionRecord(business.id);
    await this.store.update(business.id, (current) => {
      if (current.agentSessionId !== business.agentSessionId) {
        throw new Error(`业务会话 '${business.id}' 的 Claude agentSessionId 在清理期间发生变化`);
      }
      return {
        ...current,
        agentSessionId: undefined,
        claudeSessionDurable: false,
        claudeSessionPrompted: false,
        error: undefined,
      };
    });
  }

  private async setInitialTitle(sessionId: string, text: string): Promise<void> {
    const title = sessionTitleFromPrompt(text);
    if (!title) return;
    await this.store.update(sessionId, (current) => {
      if (this.isTerminal(current)) return undefined;
      const canReplace = current.title === DEFAULT_SESSION_TITLE
        || (isGreetingTitle(current.title) && !isGreetingTitle(title));
      if (!canReplace || current.title === title) return undefined;
      return { ...current, title };
    });
  }

  private async backfillPlaceholderTitles(): Promise<void> {
    const sessions = (await this.store.list())
      .filter((session) => session.runtimeProvider === "fc-e2b" && isReplaceableSessionTitle(session.title))
      .reverse();
    for (const session of sessions) {
      let title: string | undefined;
      try {
        title = await this.firstPersistedPromptTitle(session.id);
      } catch {
        continue;
      }
      if (!title) continue;
      await this.store.update(session.id, (current) => {
        if (!isReplaceableSessionTitle(current.title) || this.isTerminal(current) || current.title === title) {
          return undefined;
        }
        return { ...current, title };
      });
    }
  }

  private async firstPersistedPromptTitle(sessionId: string): Promise<string | undefined> {
    let cursor: string | undefined;
    let greeting: string | undefined;
    do {
      const page = await this.persist.listEvents({ sessionId, cursor, limit: 200 });
      for (const event of page.items) {
        const title = sessionTitleFromEvent(event);
        if (!title) continue;
        if (!isGreetingTitle(title)) return title;
        greeting ??= title;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return greeting;
  }

  private async runPrompt(
    sessionId: string,
    text: string,
    promptToken: symbol,
    session: Session,
    lease: RuntimeLease,
  ): Promise<void> {
    let rejected = false;
    let promptError: unknown;
    try {
      await session.prompt([{ type: "text", text }]);
    } catch (error) {
      rejected = true;
      promptError = error;
    }

    try {
      if (!this.isPromptCurrent(sessionId, promptToken)) return;
      if (rejected && isAcpTransportFailure(promptError)) {
        await this.recoverTransportFailure(promptError);
        return;
      }
      await this.store.update(sessionId, (current) => {
        if (!this.isPromptCurrent(sessionId, promptToken) || this.isTerminal(current)) return undefined;
        // Prompt 已经结束；在 ready/failed 写入可见前先释放内存令牌，避免
        // 客户端刚观察到 ready 就发送下一轮时仍命中 “already running”。
        this.activePrompts.delete(sessionId);
        return rejected
          ? {
              ...current,
              status: "failed",
              error: promptError instanceof Error ? promptError.message : String(promptError),
            }
          : { ...current, status: "ready", claudeSessionDurable: true, error: undefined };
      });
    } catch (error) {
      // Prompt completion runs after the HTTP 202 response. Persistence failures
      // must be visible without becoming an unhandled rejection that kills API.
      console.error(`[agent-session-manager] failed to finalize prompt for '${sessionId}'`, error);
    } finally {
      if (this.isPromptCurrent(sessionId, promptToken)) this.activePrompts.delete(sessionId);
      lease.release();
    }
  }

  private isRuntimeGenerationCurrent(sessionId: string, generation: symbol): boolean {
    return this.handles.get(sessionId)?.generation === generation;
  }

  private assertRuntimeGenerationCurrent(sessionId: string, generation: symbol): void {
    if (!this.isRuntimeGenerationCurrent(sessionId, generation)) {
      throw new Error(`session '${sessionId}' runtime was invalidated while connecting`);
    }
  }

  private scheduleIdleDispose(sessionId: string, entry: RuntimeEntry): void {
    this.clearIdleTimer(sessionId);
    if (this.handles.get(sessionId) !== entry) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const use = this.handleUsers.get(sessionId);
      if ((use && use.entry === entry) || this.handles.get(sessionId) !== entry) return;
      this.handles.delete(sessionId);
      this.beginRuntimeClose(sessionId, entry, false);
    }, this.config.fc.runtimeIdleMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private async disposeRuntime(sessionId: string, cancelPrompt = false): Promise<void> {
    this.clearIdleTimer(sessionId);
    this.handleUsers.delete(sessionId);
    const entry = this.handles.get(sessionId);
    this.handles.delete(sessionId);
    if (entry) await this.beginRuntimeClose(sessionId, entry, cancelPrompt);
  }

  private beginRuntimeClose(sessionId: string, entry: RuntimeEntry, cancelPrompt: boolean): Promise<void> {
    const previous = this.closingRuntimes.get(sessionId) ?? Promise.resolve();
    const closing = previous
      .then(() => this.closeRuntimeHandle(entry.promise, cancelPrompt))
      .catch(() => undefined);
    this.closingRuntimes.set(sessionId, closing);
    void closing.then(() => {
      if (this.closingRuntimes.get(sessionId) === closing) this.closingRuntimes.delete(sessionId);
    });
    return closing;
  }

  private async closeRuntimeHandle(handlePromise: Promise<RuntimeHandle>, cancelPrompt: boolean): Promise<void> {
    const handle = await handlePromise.catch(() => undefined);
    if (!handle) return;
    const session = handle.session ?? (handle.sessionPromise
      ? await settleWithin(handle.sessionPromise.catch(() => undefined), RUNTIME_CLOSE_STEP_TIMEOUT_MS)
      : undefined);
    if (cancelPrompt && session) {
      await settleWithin(
        cancelNativeClaudePrompt(handle.sdk, session).catch(() => undefined),
        RUNTIME_CLOSE_STEP_TIMEOUT_MS,
      );
    }
    await handle.sdk.dispose().catch(() => undefined);
  }

  private async performTransportRecovery(error: unknown): Promise<void> {
    const handles = [...this.handles.entries()];
    const affected = new Set(this.activePrompts.keys());
    this.clearAllIdleTimers();
    this.handles.clear();
    this.handleUsers.clear();
    this.activePrompts.clear();
    // The transport already failed. Do not send session/cancel: a late cancel
    // could arrive after native resume and cancel the next prompt. New work for
    // each session waits on this close barrier before creating its next runtime.
    for (const [sessionId, entry] of handles) this.beginRuntimeClose(sessionId, entry, false);
    const message = `Agent transport disconnected: ${error instanceof Error ? error.message : String(error)}`;
    await Promise.allSettled(
      [...affected].map(async (sessionId) => {
        await this.store.update(sessionId, (current) => {
          if (this.isTerminal(current)) return undefined;
          return { ...current, status: "failed", error: message };
        });
      }),
    );
  }

  private async waitForRecovery(): Promise<void> {
    const barrier = this.recoveryBarrier;
    if (barrier) await barrier;
  }

  private async waitForRuntimeClose(sessionId: string): Promise<void> {
    while (true) {
      const closing = this.closingRuntimes.get(sessionId);
      if (!closing) return;
      await closing;
    }
  }

  private async destroyUnclaimedSandbox(
    business: BusinessSession,
    sandboxId: string | undefined,
  ): Promise<unknown | undefined> {
    if (!sandboxId) return undefined;
    const latest = await this.store.get(business.id).catch(() => undefined);
    if (latest?.sandboxId === sandboxId) return undefined;
    try {
      await this.destroySandboxIgnoringMissing(sandboxId);
    } catch (error) {
      return error;
    }
    await this.store.update(business.id, (current) => {
      if (current.pendingSandboxId !== sandboxId) return undefined;
      return { ...current, pendingSandboxId: undefined };
    }).catch(() => undefined);
    return undefined;
  }

  private async destroySandboxIgnoringMissing(sandboxId: string): Promise<void> {
    try {
      await this.provider.destroy(sandboxId);
    } catch (error) {
      if (!isFcSandboxNotFoundError(error)) throw error;
    }
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private clearAllIdleTimers(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private workspacePath(workspaceRoot: string, input: string): string {
    const raw = input.trim();
    if (!raw || raw === ".") return workspaceRoot;
    if (raw.startsWith("/")) {
      const normalized = path.normalize(raw);
      if (normalized === workspaceRoot || normalized.startsWith(`${workspaceRoot}/`)) return normalized;
      throw new Error(`path escapes workspace: ${input}`);
    }
    const normalized = path.normalize(path.join(workspaceRoot, raw));
    if (normalized === workspaceRoot || normalized.startsWith(`${workspaceRoot}/`)) return normalized;
    throw new Error(`path escapes workspace: ${input}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function rpcId(value: unknown): string | undefined {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `number:${value}`;
  return undefined;
}

function buildPreviewRecoveryPrompt(intent: PreviewIntent): string {
  return [
    PREVIEW_RECOVERY_PROMPT_PREFIX,
    "",
    "该会话之前存在可用的页面预览，但沙箱实例已经被替换，原页面进程已经停止。",
    `原项目目录：${intent.projectRoot}`,
    `原预览端口：${intent.port}`,
    `原健康检查路径：${intent.healthPath}`,
    ...(intent.startCommand ? [`已记录启动命令：${intent.startCommand}`] : []),
    "",
    "请检查持久化 workspace 中的现有项目，识别实际技术栈和正确启动方式，重新启动页面服务，并执行 codeagent-preview publish。",
    "尽量复用原项目目录、端口和健康检查路径。不要修改与恢复页面无关的代码，也不要向用户输出说明。",
  ].join("\n");
}

function previewStatusFromIntent(status: "recovering" | "unavailable", intent: PreviewIntent): PreviewStatus {
  return {
    status,
    port: intent.port,
    projectRoot: intent.projectRoot,
    updatedAt: intent.lastReadyAt,
  };
}

function withoutInternalPreviewFields(status: PreviewStatus): PreviewStatus {
  const {
    healthPath: _healthPath,
    startCommand: _startCommand,
    recoverable: _recoverable,
    ...visible
  } = status;
  return visible;
}

function filterInternalPreviewRecoveryEvents(events: SessionEvent[]): SessionEvent[] {
  const shouldShow = createInternalPreviewRecoveryEventFilter();
  return [...events]
    .sort((left, right) => left.eventIndex - right.eventIndex)
    .filter((event) => shouldShow(event));
}

function createInternalPreviewRecoveryEventFilter(): (event: SessionEvent) => boolean {
  let hiddenPromptId: unknown;
  let hiding = false;

  return (event: SessionEvent) => {
    const payload = event.payload as {
      id?: unknown;
      method?: unknown;
      params?: { prompt?: Array<{ type?: unknown; text?: unknown }> };
    };
    if (event.sender === "client" && payload.method === "session/prompt") {
      const text = (payload.params?.prompt ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (text.startsWith(PREVIEW_RECOVERY_PROMPT_PREFIX)) {
        hiding = true;
        hiddenPromptId = payload.id;
        return false;
      }
      if (hiding) {
        hiding = false;
        hiddenPromptId = undefined;
      }
    }
    if (hiding) {
      if (event.sender === "agent" && payload.id !== undefined && payload.id === hiddenPromptId) {
        hiding = false;
        hiddenPromptId = undefined;
      }
      return false;
    }
    return true;
  };
}

function sessionTitleFromEvent(event: SessionEvent): string | undefined {
  if (event.sender !== "client") return undefined;
  const payload = event.payload as {
    method?: unknown;
    params?: { prompt?: Array<{ type?: unknown; text?: unknown }> };
  };
  if (payload.method !== "session/prompt") return undefined;
  const text = (payload.params?.prompt ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => (part.text as string).trim())
    .filter((part) => part && !part.startsWith(REPLAY_PROMPT_PREFIX))
    .join(" ");
  if (text.startsWith(PREVIEW_RECOVERY_PROMPT_PREFIX)) return undefined;
  return sessionTitleFromPrompt(text);
}

function sessionTitleFromPrompt(text: string): string | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length > MAX_SESSION_TITLE_LENGTH
    ? `${characters.slice(0, MAX_SESSION_TITLE_LENGTH).join("")}…`
    : normalized;
}

function isReplaceableSessionTitle(title: string): boolean {
  return title === DEFAULT_SESSION_TITLE || isGreetingTitle(title);
}

function isGreetingTitle(title: string): boolean {
  return /^(?:你好(?:呀|啊)?|您好|嗨|哈[喽啰]|在吗|hello(?: there)?|hi|hey)[!！,.，。?？~～\s]*$/iu.test(title);
}

class PreviewRecoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Preview 自动恢复超过 ${Math.ceil(timeoutMs / 1_000)} 秒，已取消`);
    this.name = "PreviewRecoveryTimeoutError";
  }
}

export function isAcpTransportFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
    if (typeof record.code === "string" && (
      record.code.startsWith("UND_ERR_")
      || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(record.code)
    )) return true;
    if (typeof record.stack === "string" && record.stack.includes("acp-http-client")) return true;
    if (typeof record.message === "string" && /\bfetch failed\b|socket (?:closed|hang up)|connection (?:closed|reset)/i.test(record.message)) {
      return true;
    }
    if (record.cause) current = record.cause;
    else break;
  }
  return false;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: number | NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = scheduleTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) cancelTimeout(timer as NodeJS.Timeout);
  }
}

async function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = scheduleTimeout(() => reject(error), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) cancelTimeout(timer);
  }
}
