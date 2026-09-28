/**
 * Langfuse tracing plugin for OpenCode (Open-Inspect sandboxes).
 *
 * Sends one Langfuse trace per user prompt, grouped into a Langfuse session per
 * Open-Inspect session. Each trace holds one generation per assistant message
 * (model, tokens, cost, output) and one span per tool call.
 *
 * Configuration (Open-Inspect > Settings > Secrets):
 *   LANGFUSE_PUBLIC_KEY   pk-lf-...
 *   LANGFUSE_SECRET_KEY   sk-lf-...
 *   LANGFUSE_HOST         optional, defaults to https://cloud.langfuse.com
 *                         (EU); use https://us.cloud.langfuse.com for US.
 *
 * Without both keys the plugin does nothing. Tracing errors never break the
 * session: they are logged once and dropped.
 */

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;
const MAX_TEXT_CHARS = 20000;

function readOpenInspectSession() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || null;
  } catch {
    return null;
  }
}

function truncate(value) {
  if (typeof value !== "string") return value;
  return value.length > MAX_TEXT_CHARS
    ? `${value.slice(0, MAX_TEXT_CHARS)}… [truncated ${value.length - MAX_TEXT_CHARS} chars]`
    : value;
}

function iso(ms) {
  return new Date(ms ?? Date.now()).toISOString();
}

export const LangfusePlugin = async () => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return {};

  const host = (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const authHeader = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const openInspectSessionId = readOpenInspectSession();
  const repo =
    process.env.REPO_OWNER && process.env.REPO_NAME
      ? `${process.env.REPO_OWNER}/${process.env.REPO_NAME}`
      : undefined;

  const queue = [];
  let flushing = null;
  let warned = false;
  let eventCounter = 0;

  // OpenCode session -> id of the trace for its current user prompt
  const currentTrace = new Map();
  // assistant message id -> { partId -> text }
  const assistantText = new Map();
  // tool call id -> start time
  const toolStarts = new Map();

  function enqueue(type, body) {
    eventCounter += 1;
    queue.push({
      id: `${Date.now().toString(36)}-${eventCounter}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: iso(),
      type,
      body,
    });
    if (queue.length >= MAX_BATCH_SIZE) void flush();
  }

  async function flush() {
    if (flushing) return flushing;
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    flushing = (async () => {
      try {
        const response = await fetch(`${host}/api/public/ingestion`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: authHeader },
          body: JSON.stringify({ batch }),
        });
        if (!response.ok && response.status !== 207 && !warned) {
          warned = true;
          console.error(`[langfuse] ingestion failed: HTTP ${response.status}`);
        }
      } catch (error) {
        if (!warned) {
          warned = true;
          console.error(`[langfuse] ingestion failed: ${error?.message ?? error}`);
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref?.();

  function traceBase(sessionID) {
    return {
      sessionId: openInspectSessionId ?? sessionID,
      metadata: {
        opencodeSessionId: sessionID,
        openInspectSessionId: openInspectSessionId ?? undefined,
        repository: repo,
      },
      tags: ["open-inspect", "opencode"],
    };
  }

  function messageOutput(messageID) {
    const parts = assistantText.get(messageID);
    if (!parts) return undefined;
    return truncate([...parts.values()].join("\n").trim()) || undefined;
  }

  return {
    "chat.message": async (input, output) => {
      const traceId = output.message?.id ?? input.messageID;
      if (!traceId) return;
      currentTrace.set(input.sessionID, traceId);
      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n");
      enqueue("trace-create", {
        id: traceId,
        name: repo ? `opencode ${repo}` : "opencode",
        timestamp: iso(output.message?.time?.created),
        input: truncate(prompt),
        ...traceBase(input.sessionID),
      });
    },

    "tool.execute.before": async (input) => {
      toolStarts.set(input.callID, Date.now());
    },

    "tool.execute.after": async (input, output) => {
      const traceId = currentTrace.get(input.sessionID);
      if (!traceId) return;
      const startedAt = toolStarts.get(input.callID);
      toolStarts.delete(input.callID);
      enqueue("span-create", {
        id: input.callID,
        traceId,
        name: `tool:${input.tool}`,
        startTime: iso(startedAt),
        endTime: iso(),
        input: input.args,
        output: truncate(output?.output),
        metadata: { title: output?.title },
      });
    },

    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (part?.type !== "text" || part.synthetic) return;
        let parts = assistantText.get(part.messageID);
        if (!parts) {
          parts = new Map();
          assistantText.set(part.messageID, parts);
        }
        parts.set(part.id, part.text);
        return;
      }

      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info?.role !== "assistant" || !info.time?.completed) return;
        const traceId = currentTrace.get(info.sessionID) ?? info.parentID;
        const text = messageOutput(info.id);
        enqueue("generation-create", {
          id: info.id,
          traceId,
          name: `${info.providerID}/${info.modelID}`,
          model: info.modelID,
          startTime: iso(info.time.created),
          endTime: iso(info.time.completed),
          output: text,
          usageDetails: {
            input: info.tokens?.input ?? 0,
            output: info.tokens?.output ?? 0,
            reasoning: info.tokens?.reasoning ?? 0,
            cache_read_input_tokens: info.tokens?.cache?.read ?? 0,
            cache_creation_input_tokens: info.tokens?.cache?.write ?? 0,
          },
          costDetails: typeof info.cost === "number" ? { total: info.cost } : undefined,
          level: info.error ? "ERROR" : "DEFAULT",
          statusMessage: info.error ? info.error.data?.message ?? info.error.name : undefined,
          metadata: { finish: info.finish, mode: info.mode },
        });
        if (traceId && text) {
          enqueue("trace-create", { id: traceId, output: text, ...traceBase(info.sessionID) });
        }
        assistantText.delete(info.id);
        return;
      }

      if (event.type === "session.idle") {
        await flush();
      }
    },

    dispose: async () => {
      clearInterval(timer);
      await flush();
    },
  };
};
