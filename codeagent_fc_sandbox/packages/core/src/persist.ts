import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ListEventsRequest,
  ListPage,
  ListPageRequest,
  SessionEvent,
  SessionPersistDriver,
  SessionRecord,
} from "sandbox-agent";

type EventListener = (event: SessionEvent) => void;
type VersionedSessionRecord = SessionRecord & { _codeagentConnectionEpoch?: number };
interface PendingSessionConnection {
  connectionId: string;
  events: SessionEvent[];
}

export class FileSessionPersistDriver implements SessionPersistDriver {
  private readonly sessionsDir: string;
  private readonly eventsDir: string;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sessionWriteTails = new Map<string, Promise<void>>();
  private readonly pendingConnections = new Map<string, PendingSessionConnection>();
  private readonly retiredConnections = new Map<string, Set<string>>();

  constructor(rootDir: string) {
    this.sessionsDir = path.join(rootDir, "sdk-sessions");
    this.eventsDir = path.join(rootDir, "sdk-events");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.eventsDir, { recursive: true });
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.sessionPath(id), "utf8")) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const files = (await fs.readdir(this.sessionsDir)).filter((file) => file.endsWith(".json"));
    const sessions = await Promise.all(
      files.map(async (file) => JSON.parse(await fs.readFile(path.join(this.sessionsDir, file), "utf8")) as SessionRecord),
    );
    sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return paginate(sessions, request);
  }

  async updateSession(session: SessionRecord): Promise<void> {
    return this.serializeSessionWrite(session.id, async () => {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      const current = await this.readSessionIfPresent(session.id) as VersionedSessionRecord | undefined;
      const incoming = session as VersionedSessionRecord;
      const deletedEpoch = await this.readDeletedSessionEpoch(session.id);
      const currentEpoch = current?._codeagentConnectionEpoch ?? 0;
      const incomingEpoch = incoming._codeagentConnectionEpoch ?? 0;
      if (deletedEpoch !== undefined && incomingEpoch <= deletedEpoch) return;
      if (current && incomingEpoch < currentEpoch) return;
      await writeJsonAtomic(this.sessionPath(session.id), session);
    });
  }

  /** 删除 SDK SessionRecord，但保留事件 JSONL 及其 eventIndex。 */
  async deleteSessionRecord(id: string): Promise<void> {
    return this.serializeSessionWrite(id, async () => {
      this.pendingConnections.delete(id);
      this.retiredConnections.delete(id);
      const current = await this.readSessionIfPresent(id) as VersionedSessionRecord | undefined;
      const deletedEpoch = await this.readDeletedSessionEpoch(id);
      if (current) {
        await writeJsonAtomic(this.deletedSessionEpochPath(id), {
          epoch: Math.max(deletedEpoch ?? 0, current._codeagentConnectionEpoch ?? 0),
        });
      }
      await fs.rm(this.sessionPath(id), { force: true });
    });
  }

  async promoteSessionConnection(session: SessionRecord): Promise<void> {
    return this.serializeSessionWrite(session.id, async () => {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      const current = await this.readSessionIfPresent(session.id) as VersionedSessionRecord | undefined;
      const deletedEpoch = await this.readDeletedSessionEpoch(session.id);
      const next: VersionedSessionRecord = {
        ...session,
        _codeagentConnectionEpoch: Math.max(
          current?._codeagentConnectionEpoch ?? 0,
          deletedEpoch ?? 0,
        ) + 1,
      };
      await writeJsonAtomic(this.sessionPath(session.id), next);
      await fs.rm(this.deletedSessionEpochPath(session.id), { force: true });
      const pending = this.pendingConnections.get(session.id);
      if (pending?.connectionId === session.lastConnectionId) {
        const persisted = await this.readEvents(session.id);
        let nextEventIndex = persisted.reduce(
          (maximum, event) => Math.max(maximum, event.eventIndex),
          0,
        ) + 1;
        for (const event of pending.events.sort(compareEvents)) {
          const accepted = { ...event, eventIndex: nextEventIndex++ };
          await fs.mkdir(this.eventsDir, { recursive: true });
          await fs.appendFile(this.eventsPath(session.id), JSON.stringify(accepted) + "\n", "utf8");
          this.emitEvent(session.id, accepted);
        }
        this.pendingConnections.delete(session.id);
      }
    });
  }

  async beginSessionConnection(sessionId: string, connectionId: string): Promise<void> {
    return this.serializeSessionWrite(sessionId, async () => {
      const pending = this.pendingConnections.get(sessionId);
      if (pending && pending.connectionId !== connectionId) {
        throw new Error(`session '${sessionId}' already has a pending ACP connection`);
      }
      const current = await this.readSessionIfPresent(sessionId);
      if (current?.lastConnectionId && current.lastConnectionId !== connectionId) {
        const retired = this.retiredConnections.get(sessionId) ?? new Set<string>();
        retired.add(current.lastConnectionId);
        this.retiredConnections.set(sessionId, retired);
      }
      this.pendingConnections.set(sessionId, pending ?? { connectionId, events: [] });
    });
  }

  async abortSessionConnection(sessionId: string, connectionId: string): Promise<void> {
    return this.serializeSessionWrite(sessionId, async () => {
      if (this.pendingConnections.get(sessionId)?.connectionId === connectionId) {
        this.pendingConnections.delete(sessionId);
      }
    });
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const events = await this.readEvents(request.sessionId);
    events.sort(compareEvents);
    return paginate(events, request);
  }

  async listEventsAfter(sessionId: string, eventIndex: number): Promise<SessionEvent[]> {
    const events = await this.readEvents(sessionId);
    return events.filter((event) => event.eventIndex > eventIndex).sort(compareEvents);
  }

  async insertEvent(sessionId: string, event: SessionEvent): Promise<void> {
    return this.serializeSessionWrite(sessionId, async () => {
      const current = await this.readSessionIfPresent(sessionId);
      const pending = this.pendingConnections.get(sessionId);
      if (pending) {
        if (pending.connectionId === event.connectionId) pending.events.push(event);
        return;
      }
      if (
        this.retiredConnections.get(sessionId)?.has(event.connectionId)
        || (current && current.lastConnectionId !== event.connectionId)
      ) {
        return;
      }

      await fs.mkdir(this.eventsDir, { recursive: true });
      const events = await this.readEvents(sessionId);
      if (events.some((existing) => existing.eventIndex === event.eventIndex)) {
        throw new Error("UNIQUE constraint failed: agent_events.session_id, agent_events.event_index");
      }
      await fs.appendFile(this.eventsPath(sessionId), JSON.stringify(event) + "\n", "utf8");
      this.emitEvent(sessionId, event);
    });
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  private async readEvents(sessionId: string): Promise<SessionEvent[]> {
    try {
      const text = await fs.readFile(this.eventsPath(sessionId), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${safeName(sessionId)}.json`);
  }

  private async readSessionIfPresent(id: string): Promise<SessionRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.sessionPath(id), "utf8")) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readDeletedSessionEpoch(id: string): Promise<number | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.deletedSessionEpochPath(id), "utf8")) as { epoch?: unknown };
      const epoch = Number(value.epoch);
      return Number.isInteger(epoch) && epoch >= 0 ? epoch : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private deletedSessionEpochPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${safeName(sessionId)}.deleted-epoch`);
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.eventsDir, `${safeName(sessionId)}.jsonl`);
  }

  private emitEvent(sessionId: string, event: SessionEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }

  private serializeSessionWrite(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.sessionWriteTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.sessionWriteTails.set(id, tail);
    void tail.then(() => {
      if (this.sessionWriteTails.get(id) === tail) this.sessionWriteTails.delete(id);
    });
    return result;
  }
}

function paginate<T>(items: T[], request: ListPageRequest = {}): ListPage<T> {
  const offset = Number.isFinite(Number(request.cursor)) ? Math.max(0, Number.parseInt(request.cursor ?? "0", 10)) : 0;
  const limit = Number.isFinite(Number(request.limit)) && Number(request.limit) > 0 ? Math.floor(Number(request.limit)) : 100;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function compareEvents(a: SessionEvent, b: SessionEvent): number {
  return a.eventIndex - b.eventIndex || a.id.localeCompare(b.id);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
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
