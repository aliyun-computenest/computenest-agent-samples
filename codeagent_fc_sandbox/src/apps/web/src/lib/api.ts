export type BusinessSessionStatus =
  | "creating"
  | "ready"
  | "running"
  | "failed"
  | "deleting"
  | "delete_failed"
  | "terminated"
  | "deleted";

export interface BusinessSession {
  id: string;
  runtimeProvider: "fc-e2b";
  userId: string;
  projectId: string;
  title: string;
  status: BusinessSessionStatus;
  sandboxId?: string;
  sandboxProviderId?: string;
  agentSessionId?: string;
  templateName: string;
  workspaceRoot: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
}

export interface SessionEvent {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: Record<string, unknown>;
}

export interface FsEntry {
  entryType: "file" | "directory";
  modified?: string | null;
  name: string;
  path: string;
  size: number;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function createClientId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const previewClientId = window.localStorage.getItem("codeagent-preview-client-id") ?? createClientId();
window.localStorage.setItem("codeagent-preview-client-id", previewClientId);
let previewSelection = Date.now();

export const api = {
  health: () => requestJson<{ status: string; provider: "fc-e2b"; template: string; region: string }>("/health"),
  listSessions: () => requestJson<BusinessSession[]>("/api/sessions"),
  createSession: (title?: string) =>
    requestJson<BusinessSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        userId: "user-1",
        projectId: `project-${Math.floor(Math.random() * 900000 + 100000)}`,
        title,
      }),
    }),
  getSession: (sessionId: string) => requestJson<BusinessSession>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  sendMessage: (sessionId: string, content: string) =>
    requestJson<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteSession: (sessionId: string) =>
    requestJson<BusinessSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  listFiles: (sessionId: string, path = "") =>
    requestJson<FsEntry[]>(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`),
  readFile: async (sessionId: string, path: string) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await response.text());
    return response.text();
  },
  writeFile: (sessionId: string, path: string, content: string) =>
    requestJson<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body: content,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  workspaceSnapshot: (sessionId: string) =>
    requestJson<WorkspaceSnapshotEntry[]>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/snapshot`),
  previewStatus: (sessionId: string) =>
    requestJson<PreviewStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/preview/status`, {
      headers: {
        "x-codeagent-preview-client-id": previewClientId,
        "x-codeagent-preview-selection": String(++previewSelection),
      },
    }),
};
