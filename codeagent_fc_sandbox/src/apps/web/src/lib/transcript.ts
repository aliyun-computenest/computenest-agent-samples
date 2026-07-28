import type { TranscriptEntry } from "@sandbox-agent/react";
import type { SessionEvent } from "./api";

export function buildTranscript(events: SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let assistantId: string | null = null;
  let assistantText = "";
  let thoughtId: string | null = null;
  let thoughtText = "";
  const tools = new Map<string, TranscriptEntry>();

  const flushAssistant = () => {
    assistantId = null;
    assistantText = "";
  };
  const flushThought = () => {
    thoughtId = null;
    thoughtText = "";
  };

  for (const event of [...events].sort((a, b) => a.eventIndex - b.eventIndex)) {
    const payload = event.payload ?? {};
    const method = typeof payload.method === "string" ? payload.method : "";
    const time = new Date(event.createdAt).toISOString();

    if (event.sender === "client" && method === "session/prompt") {
      flushAssistant();
      flushThought();
      const params = payload.params as { prompt?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (params?.prompt ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text!.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (text) {
        entries.push({ id: event.id, eventId: event.id, kind: "message", time, role: "user", text });
      }
      continue;
    }

    if (event.sender === "agent" && method === "session/update") {
      const params = payload.params as { update?: Record<string, unknown> } | undefined;
      const update = params?.update;
      if (!update) continue;
      const updateKind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";

      if (updateKind === "agent_message_chunk") {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          flushThought();
          if (!assistantId) {
            assistantId = `assistant-${event.id}`;
            assistantText = "";
            entries.push({ id: assistantId, eventId: event.id, kind: "message", time, role: "assistant", text: "" });
          }
          assistantText += content.text;
          const entry = entries.find((item) => item.id === assistantId);
          if (entry) {
            entry.text = assistantText;
            entry.time = time;
          }
        }
        continue;
      }

      if (updateKind === "agent_thought_chunk") {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          flushAssistant();
          if (!thoughtId) {
            thoughtId = `thought-${event.id}`;
            thoughtText = "";
            entries.push({ id: thoughtId, eventId: event.id, kind: "reasoning", time, reasoning: { text: "", visibility: "public" } });
          }
          thoughtText += content.text;
          const entry = entries.find((item) => item.id === thoughtId);
          if (entry?.reasoning) {
            entry.reasoning.text = thoughtText;
            entry.time = time;
          }
        }
        continue;
      }

      if (updateKind === "tool_call" || updateKind === "tool_call_update") {
        flushAssistant();
        flushThought();
        const toolCallId = String(update.toolCallId ?? event.id);
        const existing = tools.get(toolCallId);
        const status = stringify(update.status) || existing?.toolStatus || "running";
        const title = stringify(update.title) || existing?.toolName || "Tool";
        const output = update.rawOutput ?? update.content ?? update.output;
        const input = update.rawInput ?? update.input;
        if (existing) {
          existing.time = time;
          existing.toolName = title;
          existing.toolStatus = normalizeStatus(status);
          if (input !== undefined) existing.toolInput = formatValue(input);
          if (output !== undefined) existing.toolOutput = formatValue(output);
        } else {
          const entry: TranscriptEntry = {
            id: `tool-${toolCallId}`,
            eventId: event.id,
            kind: "tool",
            time,
            toolName: title,
            toolStatus: normalizeStatus(status),
            toolInput: input === undefined ? undefined : formatValue(input),
            toolOutput: output === undefined ? undefined : formatValue(output),
          };
          tools.set(toolCallId, entry);
          entries.push(entry);
        }
        continue;
      }

      if (updateKind === "plan") {
        const planEntries = (update.entries as Array<{ content: string; status: string }> | undefined) ?? [];
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "meta",
          time,
          meta: { title: "Plan", detail: planEntries.map((item) => `${item.status}: ${item.content}`).join("\n"), severity: "info" },
        });
        continue;
      }

      if (updateKind && !["usage_update", "available_commands_update", "config_option_update"].includes(updateKind)) {
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "meta",
          time,
          meta: { title: updateKind, severity: "info" },
        });
      }
      continue;
    }

    if (event.sender === "agent" && method === "session/request_permission") {
      const params = payload.params as { options?: Array<{ optionId: string; name: string; kind: string }>; toolCall?: { title?: string; description?: string } } | undefined;
      entries.push({
        id: event.id,
        eventId: event.id,
        kind: "permission",
        time,
        permission: {
          permissionId: String(payload.id ?? event.id),
          title: params?.toolCall?.title ?? "Permission request",
          description: params?.toolCall?.description,
          options: params?.options ?? [],
          resolved: true,
          selectedOptionId: "always",
        },
      });
    }
  }

  return entries;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeStatus(value: string): string {
  if (value === "completed") return "done";
  if (value === "in_progress") return "running";
  return value || "running";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
