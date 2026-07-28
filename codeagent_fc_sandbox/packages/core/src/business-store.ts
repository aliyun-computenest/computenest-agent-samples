import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type BusinessSessionStatus =
  | "creating"
  | "ready"
  | "running"
  | "failed"
  | "deleting"
  | "delete_failed"
  | "terminated"
  | "deleted";

export interface PreviewIntent {
  desired: boolean;
  projectRoot: string;
  port: number;
  healthPath: string;
  startCommand?: string;
  lastReadyAt: string;
  recoveryEpoch?: number;
  recoveryStatus?: "running" | "pending" | "ready" | "failed";
  recoveryError?: string;
}

export interface BusinessSession {
  id: string;
  runtimeProvider: "fc-e2b";
  userId: string;
  projectId: string;
  title: string;
  status: BusinessSessionStatus;
  sandboxId?: string;
  sandboxProviderId?: string;
  pendingSandboxId?: string;
  agentSessionId?: string;
  /**
   * true 表示至少一次 Claude prompt 已成功完成，可以严格执行原生 resume。
   * false 表示 session/new 已完成但尚无成功 prompt；undefined 是升级前的旧记录。
   */
  claudeSessionDurable?: boolean;
  /** 一旦开始发送首条 prompt 就保持为 true；是否已完成仍以持久化的 ACP 响应为准。 */
  claudeSessionPrompted?: boolean;
  ossPrefix?: string;
  templateName: string;
  workspaceRoot: string;
  claudeConfigDir?: string;
  recoveryEpoch?: number;
  previewIntent?: PreviewIntent;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class BusinessSessionCorruptError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`业务会话持久化文件损坏或不完整: ${filePath}`, { cause });
    this.name = "BusinessSessionCorruptError";
    this.filePath = filePath;
  }
}

export class BusinessSessionStore {
  private readonly root: string;
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(rootDir: string) {
    this.root = path.join(rootDir, "business-sessions");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const files = (await fs.readdir(this.root)).filter((file) => file.endsWith(".json"));
    await Promise.all(files.map((file) => this.readFile(path.join(this.root, file))));
  }

  async create(input: Omit<BusinessSession, "createdAt" | "updatedAt">): Promise<BusinessSession> {
    return this.serializeWrite(input.id, async () => {
      const now = new Date().toISOString();
      return this.write({ ...input, createdAt: now, updatedAt: now });
    });
  }

  async save(session: BusinessSession): Promise<BusinessSession> {
    return this.serializeWrite(session.id, () => this.write(session));
  }

  /** 在同一会话的写队列内完成读取、修改和原子替换，避免 stale read 覆盖新字段。 */
  async update(
    id: string,
    mutate: (current: BusinessSession) => BusinessSession | undefined,
  ): Promise<BusinessSession> {
    return this.serializeWrite(id, async () => {
      const current = await this.readFile(this.pathFor(id));
      const next = mutate(current);
      if (!next) return current;
      if (next.id !== id) throw new Error(`业务会话更新不能修改 ID: ${id} -> ${next.id}`);
      return this.write(next);
    });
  }

  async get(id: string): Promise<BusinessSession | undefined> {
    try {
      return await this.readFile(this.pathFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async require(id: string): Promise<BusinessSession> {
    const session = await this.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  async list(): Promise<BusinessSession[]> {
    await fs.mkdir(this.root, { recursive: true });
    const files = (await fs.readdir(this.root)).filter((file) => file.endsWith(".json"));
    const sessions = await Promise.all(files.map((file) => this.readFile(path.join(this.root, file))));
    return sessions.filter((session) => session.status !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async write(session: BusinessSession): Promise<BusinessSession> {
    await fs.mkdir(this.root, { recursive: true });
    const next = { ...session, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.pathFor(next.id), next);
    return next;
  }

  private async readFile(filePath: string): Promise<BusinessSession> {
    const text = await fs.readFile(filePath, "utf8");
    try {
      return JSON.parse(text) as BusinessSession;
    } catch (error) {
      throw new BusinessSessionCorruptError(filePath, error);
    }
  }

  private serializeWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(id, tail);
    void tail.then(() => {
      if (this.writeTails.get(id) === tail) this.writeTails.delete(id);
    });
    return result;
  }

  private pathFor(id: string): string {
    return path.join(this.root, `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  }
}

export function createBusinessSessionId(): string {
  return `sess_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
