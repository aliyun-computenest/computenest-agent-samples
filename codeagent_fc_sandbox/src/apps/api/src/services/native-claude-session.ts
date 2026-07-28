import { type SandboxAgent, type Session, type SessionPersistDriver, type SessionRecord } from "sandbox-agent";

const CLAUDE_AGENT = "claude";

export interface NativeClaudeSessionRequest {
  sdk: SandboxAgent;
  persist: SessionPersistDriver;
  id: string;
  agentSessionId?: string;
  cwd: string;
  mode?: string;
  model?: string;
}

export class NativeClaudeSessionResumeError extends Error {
  readonly sessionId: string;
  readonly agentSessionId: string;

  constructor(sessionId: string, agentSessionId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Claude 原生会话恢复失败（业务会话 ${sessionId}，Claude 会话 ${agentSessionId}）：${detail}`, { cause });
    this.name = "NativeClaudeSessionResumeError";
    this.sessionId = sessionId;
    this.agentSessionId = agentSessionId;
  }
}

export function isNativeClaudeSessionResourceNotFound(error: unknown): boolean {
  if (!(error instanceof NativeClaudeSessionResumeError)) return false;
  let current: unknown = error.cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; data?: unknown; message?: unknown; cause?: unknown };
    const resourceUri = isObject(record.data) && typeof record.data.uri === "string"
      ? record.data.uri
      : undefined;
    if (
      record.name === "AcpRpcError"
      && Number(record.code) === -32002
      && typeof record.message === "string"
      && /resource not found/i.test(record.message)
      && (resourceUri === error.agentSessionId || record.message.includes(error.agentSessionId))
    ) return true;
    current = record.cause;
  }
  return false;
}

/**
 * 直接向 Claude ACP adapter 发送 session/cancel。
 *
 * sandbox-agent 0.4.0 禁止公开 rawSend("session/cancel")，而 destroySession
 * 在连接丢失时可能走它自己的“新建并回放”恢复逻辑，因此 cancel 也集中在
 * 这个私有兼容层中。
 */
export async function cancelNativeClaudePrompt(sdk: SandboxAgent, session: Session): Promise<void> {
  const privateClient = privateSdk(sdk);
  const live = privateLiveConnection(await privateClient.getLiveConnection.call(sdk, session.agent));
  await live.acp.cancel.call(live.acp.raw, { sessionId: session.agentSessionId });
}

/**
 * 创建业务新会话，或通过 ACP session/resume 恢复原 Claude 会话。
 *
 * sandbox-agent 0.4.0 的公开 resume API 会创建新会话并回放本地事件；
 * 在它提供原生 resume API 前，所有私有接口兼容逻辑都集中在本文件。
 */
export async function resumeOrCreateNativeClaudeSession(request: NativeClaudeSessionRequest): Promise<Session> {
  const id = required(request.id, "业务会话 ID");
  const cwd = required(request.cwd, "Claude 会话工作目录");
  const businessAgentSessionId = optional(request.agentSessionId);
  const persisted = await request.persist.getSession(id);

  if (!persisted && !businessAgentSessionId) {
    const session = await request.sdk.createSession({
      id,
      agent: CLAUDE_AGENT,
      cwd,
    });
    const connectionPersist = request.persist as SessionPersistDriver & {
      promoteSessionConnection?: (record: SessionRecord) => Promise<void>;
    };
    if (typeof connectionPersist.promoteSessionConnection === "function") {
      await connectionPersist.promoteSessionConnection(session.toRecord());
    }
    await applyRequestedConfiguration(session, request);
    return session;
  }

  validatePersistedRecord(id, businessAgentSessionId, persisted);
  const agentSessionId = businessAgentSessionId ?? persisted?.agentSessionId;
  if (!agentSessionId) {
    throw new Error(`业务会话 '${id}' 缺少 Claude agentSessionId，无法执行原生恢复`);
  }

  let session: Session;
  try {
    const sdk = privateSdk(request.sdk);
    const live = privateLiveConnection(await sdk.getLiveConnection.call(request.sdk, CLAUDE_AGENT));
    const connectionPersist = request.persist as SessionPersistDriver & {
      beginSessionConnection?: (sessionId: string, connectionId: string) => Promise<void>;
      promoteSessionConnection?: (record: SessionRecord) => Promise<void>;
      abortSessionConnection?: (sessionId: string, connectionId: string) => Promise<void>;
    };
    await connectionPersist.beginSessionConnection?.(id, live.connectionId);
    const record: SessionRecord =
      persisted ??
      ({
        id,
        agent: CLAUDE_AGENT,
        agentSessionId,
        lastConnectionId: live.connectionId,
        createdAt: Date.now(),
        sandboxId: request.sdk.sandboxId,
        sessionInit: { cwd, mcpServers: [] },
      } satisfies SessionRecord);

    let response: NativeResumeResponse;
    try {
      // 先绑定才能让 resume 期间产生的 ACP envelope 映射回业务会话。
      // PersistDriver 会暂存新 connection 的事件，正式晋升后才交给 SSE。
      live.bindSession.call(live.raw, id, agentSessionId);
      response = await live.acp.unstableResumeSession.call(live.acp.raw, {
        sessionId: agentSessionId,
        cwd,
        mcpServers: record.sessionInit?.mcpServers ?? [],
      });
    } catch (error) {
      await connectionPersist.abortSessionConnection?.(id, live.connectionId).catch(() => undefined);
      throw error;
    }
    const updated: SessionRecord = {
      ...record,
      agentSessionId,
      lastConnectionId: live.connectionId,
      sandboxId: request.sdk.sandboxId,
      destroyedAt: undefined,
      configOptions:
        response.configOptions === undefined
          ? record.configOptions
          : response.configOptions
            ? structuredClone(response.configOptions)
            : undefined,
      modes:
        response.modes === undefined
          ? record.modes
          : response.modes
            ? structuredClone(response.modes)
            : null,
    };
    try {
      if (typeof connectionPersist.promoteSessionConnection === "function") {
        await connectionPersist.promoteSessionConnection(updated);
      } else {
        await request.persist.updateSession(updated);
      }
    } catch (error) {
      await connectionPersist.abortSessionConnection?.(id, live.connectionId).catch(() => undefined);
      throw error;
    }
    session = sdk.upsertSessionHandle.call(request.sdk, updated);
  } catch (error) {
    throw new NativeClaudeSessionResumeError(id, agentSessionId, error);
  }

  await applyRequestedConfiguration(session, request);
  return session;
}

async function applyRequestedConfiguration(session: Session, request: NativeClaudeSessionRequest): Promise<void> {
  const mode = optional(request.mode);
  if (mode) await session.setMode(mode);
  const model = optional(request.model);
  if (model) await session.setModel(model);
}

interface PrivateSandboxAgent {
  getLiveConnection(agent: string): Promise<unknown>;
  upsertSessionHandle(record: SessionRecord): Session;
}

interface NativeResumeResponse {
  configOptions?: SessionRecord["configOptions"] | null;
  modes?: SessionRecord["modes"];
}

interface PrivateLiveConnection {
  raw: object;
  connectionId: string;
  bindSession: (localSessionId: string, agentSessionId: string) => void;
  acp: {
    raw: object;
    cancel(request: { sessionId: string }): Promise<void>;
    unstableResumeSession(request: {
      sessionId: string;
      cwd: string;
      mcpServers: NonNullable<SessionRecord["sessionInit"]>["mcpServers"];
    }): Promise<NativeResumeResponse>;
  };
}

function privateSdk(sdk: SandboxAgent): PrivateSandboxAgent {
  const candidate = sdk as unknown as Partial<PrivateSandboxAgent>;
  if (typeof candidate.getLiveConnection !== "function" || typeof candidate.upsertSessionHandle !== "function") {
    throw new Error("sandbox-agent 私有接口不兼容：缺少 getLiveConnection/upsertSessionHandle");
  }
  return candidate as PrivateSandboxAgent;
}

function privateLiveConnection(value: unknown): PrivateLiveConnection {
  if (!isObject(value)) throw new Error("sandbox-agent 私有接口不兼容：ACP connection 不是对象");
  if (typeof value.connectionId !== "string" || !value.connectionId.trim()) {
    throw new Error("sandbox-agent 私有接口不兼容：缺少 ACP connectionId");
  }
  if (typeof value.bindSession !== "function") {
    throw new Error("sandbox-agent 私有接口不兼容：缺少 bindSession");
  }
  if (
    !isObject(value.acp) ||
    typeof value.acp.unstableResumeSession !== "function" ||
    typeof value.acp.cancel !== "function"
  ) {
    throw new Error("sandbox-agent 私有接口不兼容：缺少 AcpHttpClient.cancel/unstableResumeSession");
  }
  return {
    raw: value,
    connectionId: value.connectionId,
    bindSession: value.bindSession as PrivateLiveConnection["bindSession"],
    acp: {
      raw: value.acp,
      cancel: value.acp.cancel as PrivateLiveConnection["acp"]["cancel"],
      unstableResumeSession: value.acp.unstableResumeSession as PrivateLiveConnection["acp"]["unstableResumeSession"],
    },
  };
}

function validatePersistedRecord(id: string, businessAgentSessionId: string | undefined, record: SessionRecord | undefined): void {
  if (!record) return;
  if (record.id !== id) {
    throw new Error(`持久化会话 ID '${record.id}' 与业务会话 ID '${id}' 不一致`);
  }
  if (record.agent !== CLAUDE_AGENT) {
    throw new Error(`业务会话 '${id}' 的持久化 agent 是 '${record.agent}'，预期为 '${CLAUDE_AGENT}'`);
  }
  if (!record.agentSessionId.trim()) {
    throw new Error(`业务会话 '${id}' 的持久化记录缺少 Claude agentSessionId`);
  }
  if (businessAgentSessionId && record.agentSessionId !== businessAgentSessionId) {
    throw new Error(
      `业务会话 '${id}' 的 Claude agentSessionId 不一致：业务记录为 '${businessAgentSessionId}'，SDK 记录为 '${record.agentSessionId}'`,
    );
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
