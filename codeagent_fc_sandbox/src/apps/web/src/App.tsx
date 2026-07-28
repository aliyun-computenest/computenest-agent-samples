import { AgentTranscript, type AgentTranscriptClassNames, type TranscriptEntry } from "@sandbox-agent/react";
import { marked } from "marked";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type BusinessSession, type FsEntry, type PreviewStatus, type SessionEvent, type WorkspaceSnapshotEntry } from "./lib/api";
import { buildTranscript } from "./lib/transcript";

marked.setOptions({ breaks: true, gfm: true });

type RightTab = "preview" | "code";

interface TreeNode {
  entry: FsEntry;
  depth: number;
}

type FileOperation = "read" | "create" | "update" | "delete";

interface FileActivity {
  id: string;
  operation: FileOperation;
  path: string;
  content: string;
  createdAt: number;
}

interface PendingToolActivity {
  name: string;
  path?: string;
  status?: string;
}

interface WorkspaceSyncState {
  dirty: boolean;
  running: boolean;
  timer?: number;
}

interface PreviewRetryState {
  sessionId: string;
  probeNonce: number;
  wasRunning: boolean;
  retryUntil: number;
}

const transcriptClasses: Partial<AgentTranscriptClassNames> = {
  root: "transcript",
  message: "message",
  messageContent: "message-content",
  messageText: "message-text",
  error: "message-error",
  toolGroupSingle: "tool-group-single",
  toolGroupContainer: "tool-group-container",
  toolGroupHeader: "tool-group-header",
  toolGroupIcon: "tool-group-icon",
  toolGroupLabel: "tool-group-label",
  toolGroupChevron: "tool-group-chevron",
  toolGroupBody: "tool-group-body",
  toolItem: "tool-item",
  toolItemConnector: "tool-item-connector",
  toolItemDot: "tool-item-dot",
  toolItemLine: "tool-item-line",
  toolItemContent: "tool-item-content",
  toolItemHeader: "tool-item-header",
  toolItemIcon: "tool-item-icon",
  toolItemLabel: "tool-item-label",
  toolItemSpinner: "tool-item-spinner",
  toolItemLink: "tool-item-link",
  toolItemChevron: "tool-item-chevron",
  toolItemBody: "tool-item-body",
  toolSection: "tool-section",
  toolSectionTitle: "tool-section-title",
  toolCode: "tool-code",
  toolCodeMuted: "muted",
  permissionPrompt: "permission-prompt",
  permissionHeader: "permission-header",
  permissionIcon: "permission-icon",
  permissionTitle: "permission-title",
  permissionDescription: "permission-description",
  permissionActions: "permission-actions",
  permissionButton: "permission-button",
  permissionAutoResolved: "permission-auto-resolved",
  thinkingRow: "thinking-row",
  thinkingIndicator: "thinking-indicator",
};

const statusMap: Record<string, { label: string; cls: string }> = {
  ready: { label: "就绪", cls: "ready" },
  running: { label: "运行中", cls: "running" },
  creating: { label: "创建中", cls: "creating" },
  failed: { label: "失败", cls: "failed" },
};

const PREVIEW_POLL_INTERVAL_MS = 1_500;
const PREVIEW_SETTLE_RETRY_MS = 45_000;

export default function App() {
  const [sessions, setSessions] = useState<BusinessSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [input, setInput] = useState("");
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [fileContent, setFileContent] = useState("");
  const [editingFile, setEditingFile] = useState(false);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [fileActivities, setFileActivities] = useState<FileActivity[]>([]);
  const [activeActivityId, setActiveActivityId] = useState("");
  const [animatedLineCount, setAnimatedLineCount] = useState(0);
  const [preview, setPreview] = useState<PreviewStatus>({ status: "none" });
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [previewProbeNonce, setPreviewProbeNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef("");
  const selectedFileRef = useRef("");
  const workspaceSyncStatesRef = useRef(new Map<string, WorkspaceSyncState>());
  const filesRefreshingRef = useRef(new Set<string>());
  const workspaceSnapshotRef = useRef(new Map<string, WorkspaceSnapshotEntry>());
  const workspaceContentRef = useRef(new Map<string, string>());
  const pendingToolsRef = useRef(new Map<string, PendingToolActivity>());
  const completedToolsRef = useRef(new Set<string>());
  const previewRevisionRef = useRef("");
  const previewRetryRef = useRef<PreviewRetryState>({ sessionId: "", probeNonce: 0, wasRunning: false, retryUntil: 0 });

  const activeSession = sessions.find((item) => item.id === activeId);
  const isPreparing = activeSession?.status === "creating";
  const isRunning = activeSession?.status === "running" || activeSession?.status === "creating";
  const workspaceRuntimeKey = activeSession?.sandboxId
    && (activeSession.status === "ready" || activeSession.status === "running")
    ? `${activeSession.id}:${activeSession.sandboxId}`
    : "";
  const transcript = useMemo(() => buildTranscript(events), [events]);
  const activeActivity = fileActivities.find((item) => item.id === activeActivityId);
  const activityLines = useMemo(() => activeActivity?.content.split("\n") ?? [], [activeActivity]);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    void refreshSessions();
    const timer = window.setInterval(() => void refreshSessions(false), 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setEvents([]);
    setChildren({});
    setExpanded({});
    setSelectedFile("");
    setFileContent("");
    setEditingFile(false);
    setArtifactOpen(false);
    setFileActivities([]);
    setActiveActivityId("");
    setPreview({ status: "none" });
    setRightTab("code");
    setPreviewReloadKey(Date.now());
    workspaceSnapshotRef.current = new Map();
    workspaceContentRef.current = new Map();
    pendingToolsRef.current = new Map();
    completedToolsRef.current = new Set();
    previewRevisionRef.current = "";
    const source = new EventSource(`/api/sessions/${encodeURIComponent(activeId)}/events?offset=0`);
    source.onmessage = (message) => {
      if (activeIdRef.current !== activeId) return;
      const event = JSON.parse(message.data) as SessionEvent;
      setEvents((current) => {
        if (current.some((item) => item.eventIndex === event.eventIndex)) return current;
        return [...current, event].sort((a, b) => a.eventIndex - b.eventIndex);
      });
      handleToolActivity(activeId, event);
    };
    source.onerror = () => {
      if (activeIdRef.current === activeId) setError("事件流断开，浏览器会自动重连");
    };
    return () => {
      source.close();
      const syncState = workspaceSyncStatesRef.current.get(activeId);
      if (syncState?.timer !== undefined) window.clearTimeout(syncState.timer);
      if (syncState) syncState.dirty = false;
      workspaceSyncStatesRef.current.delete(activeId);
    };
  }, [activeId]);

  useEffect(() => {
    if (!activeId || !workspaceRuntimeKey) return;
    void initializeWorkspace(activeId);
  }, [activeId, workspaceRuntimeKey]);

  useEffect(() => {
    if (!activeId) return;
    let retryState = previewRetryRef.current;
    if (retryState.sessionId !== activeId) {
      retryState = {
        sessionId: activeId,
        probeNonce: previewProbeNonce,
        wasRunning: isRunning,
        retryUntil: Date.now() + PREVIEW_SETTLE_RETRY_MS,
      };
      previewRetryRef.current = retryState;
    } else {
      if (retryState.probeNonce !== previewProbeNonce) {
        retryState.probeNonce = previewProbeNonce;
        retryState.retryUntil = Date.now() + PREVIEW_SETTLE_RETRY_MS;
      }
      if (retryState.wasRunning && !isRunning) {
        retryState.retryUntil = Date.now() + PREVIEW_SETTLE_RETRY_MS;
      }
      retryState.wasRunning = isRunning;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refreshPreview = async () => {
      let next: PreviewStatus;
      try {
        next = await api.previewStatus(activeId);
      } catch {
        next = { status: "unavailable" };
      }
      if (cancelled || activeIdRef.current !== activeId) return;
      setPreview(next);
      if (next.status === "ready") {
        const revision = `${next.port ?? ""}:${next.updatedAt ?? ""}`;
        if (previewRevisionRef.current !== revision) {
          previewRevisionRef.current = revision;
          setPreviewReloadKey(Date.now());
        }
        if (!isRunning) retryState.retryUntil = 0;
      }
      const withinSettleWindow = !isRunning && Date.now() < retryState.retryUntil;
      if (isRunning || next.status === "recovering" || (next.status !== "ready" && withinSettleWindow)) {
        timer = window.setTimeout(() => void refreshPreview(), PREVIEW_POLL_INTERVAL_MS);
      }
    };
    void refreshPreview();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeId, isRunning, previewProbeNonce]);

  useEffect(() => {
    if (preview.status !== "ready" || fileActivities.length === 0) return;
    setArtifactOpen(true);
  }, [preview.status, preview.origin, preview.port, preview.updatedAt, fileActivities.length]);

  useEffect(() => {
    if (!activeActivity) {
      setAnimatedLineCount(0);
      return;
    }
    if (activeActivity.operation === "delete") {
      setAnimatedLineCount(activityLines.length);
      if (!activeActivity.content) return;
      const chunkSize = activityLines.length > 180 ? 8 : activityLines.length > 60 ? 3 : 1;
      const timer = window.setInterval(() => {
        setAnimatedLineCount((current) => {
          const next = Math.max(0, current - chunkSize);
          if (next === 0) window.clearInterval(timer);
          return next;
        });
      }, 44);
      return () => window.clearInterval(timer);
    }
    setAnimatedLineCount(Math.min(1, activityLines.length));
    if (activityLines.length <= 1) return;
    const chunkSize = activityLines.length > 180 ? 8 : activityLines.length > 60 ? 3 : 1;
    const timer = window.setInterval(() => {
      setAnimatedLineCount((current) => {
        const next = Math.min(activityLines.length, current + chunkSize);
        if (next >= activityLines.length) window.clearInterval(timer);
        return next;
      });
    }, 34);
    return () => window.clearInterval(timer);
  }, [activeActivity?.id, activityLines.length]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, isRunning]);

  async function refreshSessions(activate = true) {
    const next = await api.listSessions();
    setSessions(next);
    if (activate && !activeIdRef.current && next[0]) setActiveId(next[0].id);
  }

  async function createSession() {
    setBusy(true);
    setError("");
    try {
      const session = await api.createSession("新的会话");
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteActive() {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.deleteSession(activeId);
      const next = sessions.filter((item) => item.id !== activeId);
      setSessions(next);
      setActiveId(next[0]?.id ?? "");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const content = input.trim();
    if (!activeId || !content || isRunning) return;
    setInput("");
    try {
      await api.sendMessage(activeId, content);
      void refreshSessions(false);
    } catch (err) {
      setInput(content);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function initializeWorkspace(sessionId: string) {
    try {
      const [snapshot] = await Promise.all([api.workspaceSnapshot(sessionId), loadFilesForSession(sessionId, "")]);
      if (activeIdRef.current !== sessionId) return;
      workspaceSnapshotRef.current = new Map(snapshot.map((entry) => [entry.path, entry]));
      void hydrateWorkspaceContentCache(sessionId, snapshot);
    } catch (err) {
      if (activeIdRef.current === sessionId) setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function hydrateWorkspaceContentCache(sessionId: string, snapshot: WorkspaceSnapshotEntry[]) {
    const candidates = snapshot.filter((entry) => entry.size <= 200_000).slice(0, 60);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length && activeIdRef.current === sessionId) {
        const entry = candidates[cursor++];
        try {
          const content = await api.readFile(sessionId, entry.path);
          if (activeIdRef.current !== sessionId) return;
          workspaceContentRef.current.set(entry.path, content);
        } catch {
          // Binary and unreadable files do not participate in line animations.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  }

  async function loadFiles(path: string) {
    if (!activeId) return;
    await loadFilesForSession(activeId, path);
  }

  async function loadFilesForSession(sessionId: string, path: string) {
    const root = sessions.find((item) => item.id === sessionId)?.workspaceRoot ?? "";
    const list = await api.listFiles(sessionId, path);
    if (activeIdRef.current !== sessionId) return;
    const key = path || root;
    setChildren((current) => ({ ...current, [key]: list }));
    setExpanded((current) => ({ ...current, [key]: true }));
  }

  function handleToolActivity(sessionId: string, event: SessionEvent) {
    if (activeIdRef.current !== sessionId) return;
    const update = toolUpdate(event);
    if (!update) return;
    const current = pendingToolsRef.current.get(update.toolCallId) ?? { name: "" };
    const next = {
      name: update.name || current.name,
      path: update.path || current.path,
      status: update.status || current.status,
    };
    pendingToolsRef.current.set(update.toolCallId, next);
    if (next.status !== "completed" || completedToolsRef.current.has(update.toolCallId)) return;
    completedToolsRef.current.add(update.toolCallId);
    if (next.name.toLowerCase() === "read" && next.path) {
      void showReadActivity(sessionId, update.toolCallId, next.path);
      return;
    }
    scheduleWorkspaceSync(sessionId);
  }

  async function showReadActivity(sessionId: string, toolCallId: string, filePath: string) {
    try {
      const content = await api.readFile(sessionId, filePath);
      if (activeIdRef.current !== sessionId) return;
      workspaceContentRef.current.set(filePath, content);
      pushFileActivity(sessionId, { id: `read-${toolCallId}`, operation: "read", path: filePath, content, createdAt: Date.now() });
    } catch {
      // A Read tool can target images or files outside the workspace. Those stay in the transcript.
    }
  }

  function scheduleWorkspaceSync(sessionId: string) {
    if (activeIdRef.current !== sessionId) return;
    const state = workspaceSyncStatesRef.current.get(sessionId) ?? { dirty: false, running: false };
    workspaceSyncStatesRef.current.set(sessionId, state);
    state.dirty = true;
    if (state.running) return;
    if (state.timer !== undefined) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = undefined;
      void drainWorkspaceSync(sessionId, state);
    }, 220);
  }

  async function drainWorkspaceSync(sessionId: string, state: WorkspaceSyncState) {
    if (state.running) return;
    state.running = true;
    try {
      while (state.dirty && activeIdRef.current === sessionId) {
        state.dirty = false;
        await syncWorkspaceChanges(sessionId);
      }
    } finally {
      state.running = false;
      if (state.dirty && activeIdRef.current === sessionId) scheduleWorkspaceSync(sessionId);
    }
  }

  async function syncWorkspaceChanges(sessionId: string) {
    try {
      const snapshot = await api.workspaceSnapshot(sessionId);
      if (activeIdRef.current !== sessionId) return;
      const previous = workspaceSnapshotRef.current;
      const current = new Map(snapshot.map((entry) => [entry.path, entry]));
      const changed: Array<{ operation: FileOperation; path: string; size: number }> = [];
      for (const entry of snapshot) {
        const before = previous.get(entry.path);
        if (!before) changed.push({ operation: "create", path: entry.path, size: entry.size });
        else if (before.size !== entry.size || before.modified !== entry.modified) changed.push({ operation: "update", path: entry.path, size: entry.size });
      }
      for (const filePath of previous.keys()) {
        if (!current.has(filePath)) changed.push({ operation: "delete", path: filePath, size: 0 });
      }
      workspaceSnapshotRef.current = current;

      for (const change of changed) {
        if (activeIdRef.current !== sessionId) return;
        let content = change.operation === "delete" ? workspaceContentRef.current.get(change.path) ?? "" : "";
        if (change.operation !== "delete" && change.size <= 300_000) {
          try {
            content = await api.readFile(sessionId, change.path);
            if (activeIdRef.current !== sessionId) return;
            workspaceContentRef.current.set(change.path, content);
          } catch {
            if (activeIdRef.current !== sessionId) return;
          }
        }
        pushFileActivity(sessionId, {
          id: `${Date.now()}-${change.operation}-${change.path}`,
          operation: change.operation,
          path: change.path,
          content,
          createdAt: Date.now(),
        });
        if (change.operation === "delete") workspaceContentRef.current.delete(change.path);
      }
      if (changed.length > 0) await loadFilesForSession(sessionId, "");
    } catch (err) {
      if (activeIdRef.current === sessionId) setError(err instanceof Error ? err.message : String(err));
    }
  }

  function pushFileActivity(sessionId: string, activity: FileActivity) {
    if (activeIdRef.current !== sessionId) return;
    setFileActivities((current) => [...current.filter((item) => item.id !== activity.id), activity].slice(-40));
    setActiveActivityId(activity.id);
    setSelectedFile(activity.path);
    setFileContent(activity.content);
    setEditingFile(false);
    setRightTab("code");
    setArtifactOpen(true);
  }

  async function refreshArtifacts(options: { reloadPreview?: boolean } = {}) {
    const sessionId = activeIdRef.current;
    const root = sessions.find((item) => item.id === sessionId)?.workspaceRoot || activeSession?.workspaceRoot || "";
    if (!sessionId || !root || filesRefreshingRef.current.has(sessionId)) return;
    filesRefreshingRef.current.add(sessionId);
    try {
      const list = await api.listFiles(sessionId, "");
      if (activeIdRef.current !== sessionId) return;
      setChildren((current) => ({ ...current, [root]: list }));
      setExpanded((current) => ({ ...current, [root]: true }));
      const currentFile = selectedFileRef.current;
      if (currentFile) {
        try {
          const content = await api.readFile(sessionId, currentFile);
          if (activeIdRef.current !== sessionId) return;
          setFileContent(content);
        } catch {
          if (activeIdRef.current !== sessionId) return;
          setSelectedFile("");
          setFileContent("");
        }
      }
      if (activeIdRef.current !== sessionId) return;
      if (options.reloadPreview) setPreviewReloadKey(Date.now());
    } catch (err) {
      if (activeIdRef.current === sessionId) setError(err instanceof Error ? err.message : String(err));
    } finally {
      filesRefreshingRef.current.delete(sessionId);
    }
  }

  async function openEntry(entry: FsEntry) {
    const sessionId = activeId;
    if (!sessionId) return;
    if (entry.entryType === "directory") {
      const nextExpanded = !expanded[entry.path];
      setExpanded((current) => ({ ...current, [entry.path]: nextExpanded }));
      if (nextExpanded && !children[entry.path]) await loadFiles(entry.path);
      return;
    }
    const content = await api.readFile(sessionId, entry.path);
    if (activeIdRef.current !== sessionId) return;
    setSelectedFile(entry.path);
    workspaceContentRef.current.set(entry.path, content);
    setFileContent(content);
    setActiveActivityId("");
    setEditingFile(false);
    setRightTab("code");
  }

  async function saveFile() {
    const sessionId = activeId;
    const filePath = selectedFile;
    const content = fileContent;
    const workspaceRoot = sessions.find((item) => item.id === sessionId)?.workspaceRoot ?? "";
    if (!sessionId || !filePath) return;
    await api.writeFile(sessionId, filePath, content);
    if (activeIdRef.current !== sessionId) return;
    workspaceContentRef.current.set(filePath, content);

    const snapshot = await api.workspaceSnapshot(sessionId);
    if (activeIdRef.current !== sessionId) return;
    const snapshotPath = workspaceSnapshotPath(workspaceRoot, filePath);
    const savedEntry = snapshot.find((entry) => entry.path === snapshotPath);
    const baseline = new Map(workspaceSnapshotRef.current);
    if (savedEntry) {
      baseline.set(snapshotPath, savedEntry);
      workspaceContentRef.current.set(snapshotPath, content);
    } else {
      baseline.delete(snapshotPath);
      workspaceContentRef.current.delete(snapshotPath);
    }
    workspaceSnapshotRef.current = baseline;
    setEditingFile(false);
  }

  function cancelFileEdit() {
    setFileContent(workspaceContentRef.current.get(selectedFile) ?? fileContent);
    setEditingFile(false);
  }

  const tree = useMemo(() => {
    const root = activeSession?.workspaceRoot || "";
    const rows: TreeNode[] = [];
    appendTree(rows, children, expanded, root, 0);
    return rows;
  }, [activeSession?.workspaceRoot, children, expanded]);

  return (
    <div className={`app ${artifactOpen ? "artifact-open" : "artifact-closed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">CA</span>
          <span>
            <strong>CodeAgent</strong>
            <small>{activeSession?.templateName ?? "sandbox-agent"}</small>
          </span>
        </div>
        <button className="create-button" onClick={createSession} disabled={busy}>
          <Plus size={16} />
          新建会话
          <kbd>⌘ N</kbd>
        </button>
        <div className="sidebar-heading">
          <span>会话</span>
          <button onClick={() => void refreshSessions()}>
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="session-list">
          {sessions.map((session) => {
            const st = statusMap[session.status] ?? { label: session.status, cls: session.status };
            return (
              <button key={session.id} className={`session-item ${session.id === activeId ? "active" : ""}`} onClick={() => setActiveId(session.id)}>
                <span className={`status-dot ${st.cls}`} />
                <span className="session-title">{session.title || session.projectId}</span>
                <span className={`session-status ${st.cls}`}>{st.label}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="chat-pane">
        <header className="chat-header">
          <div>
            <strong>{activeSession?.title ?? "选择或创建 Quest"}</strong>
            <span>{activeSession?.projectId ?? ""}</span>
          </div>
          <div className="header-actions">
            <button
              onClick={() => {
                setPreviewProbeNonce((current) => current + 1);
                void refreshArtifacts({ reloadPreview: true });
              }}
              disabled={!activeId}
            >
              <RefreshCw size={16} />
              同步
            </button>
            <button onClick={() => setArtifactOpen((open) => !open)} disabled={!activeId}>
              {artifactOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              {artifactOpen ? "收起产物" : "查看产物"}
            </button>
            <button className="danger" onClick={deleteActive} disabled={!activeId || busy}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </header>

        <section className="transcript-wrap">
          {activeId ? (
            <>
              <AgentTranscript
                entries={transcript}
                classNames={transcriptClasses}
                isThinking={isRunning}
                agentId="claude"
                virtualize
                renderMessageText={(entry: TranscriptEntry) => <MarkdownText text={entry.text ?? ""} />}
                renderToolItemIcon={() => <Wrench size={13} />}
                renderThinkingState={() => (
                  <div className="thinking-row">
                    <span className="thinking-dot" />
                    <span>Claude Code 正在处理</span>
                  </div>
                )}
              />
              <div ref={messageEndRef} />
            </>
          ) : (
            <div className="empty-state">新建会话后开始对话。</div>
          )}
        </section>

        <footer className="composer">
          {error ? <div className="error-line">{error}</div> : null}
          <textarea
            value={input}
            disabled={!activeId || isRunning}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={isPreparing ? "沙箱正在准备，完成后即可开始对话" : isRunning ? "Claude Code 正在执行，完成后可继续提问" : "描述任务，Enter 换行，Cmd/Ctrl + Enter 发送"}
          />
          <div className="composer-bottom">
            <span>Claude Code · qwen3.7-max</span>
            <button className="send" onClick={() => void send()} disabled={!input.trim() || !activeId || isRunning}>
              <Send size={18} />
            </button>
          </div>
        </footer>
      </main>

      <aside className={`artifact-pane ${artifactOpen ? "open" : "closed"}`} aria-hidden={!artifactOpen}>
        <header className="artifact-header">
          <div>
            <strong>实时产物</strong>
            <span>{fileActivities.length > 0 ? `AI 已操作 ${new Set(fileActivities.map((item) => item.path)).size} 个文件` : activeSession?.sandboxId ? `${compact(activeSession.sandboxId)} · 等待 AI 操作文件` : "等待沙箱就绪"}</span>
          </div>
          <button onClick={() => setArtifactOpen(false)}><PanelRightClose size={15} />收起</button>
        </header>
        <div className="artifact-tabs">
          <div className="segmented">
            {(["preview", "code"] as RightTab[]).map((tab) => (
              <button key={tab} className={rightTab === tab ? "active" : ""} onClick={() => setRightTab(tab)}>
                {tab === "preview" ? <><Eye size={14} />预览</> : <><Code2 size={14} />代码</>}
              </button>
            ))}
          </div>
        </div>

        {artifactOpen && rightTab === "preview" ? (
          <div className="preview-panel">
            <div className="preview-toolbar">
              <span className={`preview-status ${preview.status}`}><i />{previewLabel(preview.status)}</span>
              <span className="preview-meta">{preview.projectRoot ?? (preview.port ? `沙箱端口 ${preview.port}` : "AI 启动页面后会自动出现在这里")}</span>
              {preview.status === "ready" ? <button onClick={() => setPreviewReloadKey(Date.now())}><RefreshCw size={14} />刷新</button> : null}
            </div>
            {preview.status === "ready" && preview.origin ? <iframe title="preview" src={`${preview.origin}/?t=${previewReloadKey}`} /> : <PreviewEmpty status={preview.status} />}
          </div>
        ) : null}

        {rightTab === "code" ? (
          <div className="code-panel">
            <div className="file-tree">
              <div className="tree-title">代码编辑器</div>
              {tree.length === 0 ? <div className="empty-small">No files</div> : null}
              {tree.map(({ entry, depth }) => (
                <button key={entry.path} className={`tree-row ${selectedFile === entry.path ? "active" : ""}`} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => void openEntry(entry)}>
                  {entry.entryType === "directory" ? expanded[entry.path] ? <FolderOpen size={15} /> : <Folder size={15} /> : <FileText size={15} />}
                  <span title={entry.path}>{entry.name}</span>
                  {entry.entryType === "directory" ? expanded[entry.path] ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                </button>
              ))}
            </div>
            <div className="editor">
              <div className="editor-title">
                <strong title={selectedFile}>{selectedFile ? fileName(selectedFile) : "AI 操作文件时会在这里实时展示"}</strong>
                {activeActivity ? <span className={`operation-badge ${activeActivity.operation}`}>{operationLabel(activeActivity.operation)}</span> : selectedFile ? (
                  <div className="editor-actions">
                    {editingFile ? <><button onClick={cancelFileEdit}>取消</button><button onClick={saveFile}>保存</button></> : <button onClick={() => setEditingFile(true)}>编辑</button>}
                  </div>
                ) : null}
              </div>
              {activeActivity ? <LiveFileActivity activity={activeActivity} visibleLines={animatedLineCount} /> : editingFile ? <textarea value={fileContent} onChange={(event) => setFileContent(event.target.value)} spellCheck={false} wrap="off" /> : selectedFile ? <FileCodePreview content={fileContent} /> : <div className="empty-state">从左侧选择文件，或等待 AI 操作文件</div>}
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(text) }} />;
}

function appendTree(rows: TreeNode[], children: Record<string, FsEntry[]>, expanded: Record<string, boolean>, root: string, depth: number) {
  for (const entry of children[root] ?? []) {
    rows.push({ entry, depth });
    if (entry.entryType === "directory" && expanded[entry.path]) {
      appendTree(rows, children, expanded, entry.path, depth + 1);
    }
  }
}

function fileName(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

function workspaceSnapshotPath(root: string, filePath: string): string {
  if (!root) return filePath.replace(/^\.\//, "");
  if (filePath === root) return "";
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath.replace(/^\.\//, "");
}

function compact(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}...${value.slice(-4)}`;
}

function toolUpdate(event: SessionEvent): { toolCallId: string; name: string; path?: string; status?: string } | undefined {
  const payload = event.payload as { method?: unknown; params?: { update?: Record<string, unknown> } };
  if (payload.method !== "session/update") return undefined;
  const update = payload.params?.update;
  if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return undefined;
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!toolCallId) return undefined;
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | undefined;
  const input = update.rawInput as Record<string, unknown> | undefined;
  const candidatePath = input?.file_path ?? input?.path ?? input?.notebook_path;
  return {
    toolCallId,
    name: typeof meta?.claudeCode?.toolName === "string" ? meta.claudeCode.toolName : typeof update.title === "string" ? update.title : "",
    path: typeof candidatePath === "string" ? candidatePath : undefined,
    status: typeof update.status === "string" ? update.status : undefined,
  };
}

function LiveFileActivity({ activity, visibleLines }: { activity: FileActivity; visibleLines: number }) {
  if (activity.operation === "delete" && !activity.content) {
    return (
      <div className="file-removed">
        <Trash2 size={22} />
        <strong>文件已删除</strong>
        <span>{activity.path}</span>
      </div>
    );
  }
  const lines = activity.content.split("\n");
  if (!activity.content) return <div className="empty-state">文件较大或不是文本文件，已确认操作完成。</div>;
  if (activity.operation === "delete") {
    const removed = lines.length - visibleLines;
    return (
      <div className="live-code delete">
        <div className="live-code-progress" style={{ width: `${Math.min(100, (removed / Math.max(1, lines.length)) * 100)}%` }} />
        {visibleLines > 0 ? (
          <pre>
            {lines.slice(0, visibleLines).map((line, index) => (
              <span className="live-code-line" key={`${activity.id}-${index}`}>
                <i>−</i>
                <code>{line || " "}</code>
              </span>
            ))}
            <span className="typing-caret delete-caret" />
          </pre>
        ) : (
          <div className="delete-complete">
            <Trash2 size={22} />
            <strong>文件已逐行删除</strong>
            <span>{activity.path}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`live-code ${activity.operation}`}>
      <div className="live-code-progress" style={{ width: `${Math.min(100, (visibleLines / Math.max(1, lines.length)) * 100)}%` }} />
      <pre>
        {lines.slice(0, visibleLines).map((line, index) => (
          <span className="live-code-line" key={`${activity.id}-${index}`}>
            <i>{index + 1}</i>
            <code>{line || " "}</code>
          </span>
        ))}
        {visibleLines < lines.length ? <span className="typing-caret" /> : null}
      </pre>
    </div>
  );
}

function FileCodePreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="live-code file-code-preview">
      <pre>
        {lines.map((line, index) => (
          <span className="live-code-line" key={index}>
            <i>{index + 1}</i>
            <code>{line || " "}</code>
          </span>
        ))}
      </pre>
    </div>
  );
}

function PreviewEmpty({ status }: { status: PreviewStatus["status"] }) {
  const recovering = status === "recovering";
  return (
    <div className="preview-empty">
      <span className={`preview-orb ${status}`}><Eye size={22} /></span>
      <strong>{recovering ? "正在自动恢复页面预览" : status === "starting" ? "AI 正在准备预览" : status === "unavailable" ? "预览服务暂不可用" : "等待 AI 发布页面"}</strong>
      <p>{recovering ? "沙箱已重新创建，系统正在后台识别项目并重启页面服务。" : status === "unavailable" ? "页面自动恢复失败；后续新沙箱会再次尝试。" : "AI 会在沙箱内启动页面服务并写入 preview.json，这里无需手动输入命令。"}</p>
    </div>
  );
}

function operationLabel(operation: FileOperation): string {
  return operation === "read" ? "读取" : operation === "create" ? "新建" : operation === "update" ? "写入" : "删除";
}

function previewLabel(status: PreviewStatus["status"]): string {
  return status === "ready" ? "预览已就绪" : status === "recovering" ? "正在恢复" : status === "starting" ? "正在连接" : status === "unavailable" ? "服务不可用" : "等待 AI";
}
