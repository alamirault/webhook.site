/**
 * Langfuse tracing plugin for OpenCode (Open-Inspect sandboxes).
 *
 * Exports OpenTelemetry spans (OTLP/HTTP JSON) to Langfuse:
 *   - one trace per user prompt, grouped into a Langfuse session per
 *     Open-Inspect session;
 *   - one generation per assistant message (model, tokens, cost, output);
 *   - one span per tool call.
 *
 * Configuration (Open-Inspect > Settings > Secrets):
 *   LANGFUSE_PUBLIC_KEY   pk-lf-...
 *   LANGFUSE_SECRET_KEY   sk-lf-...
 *   LANGFUSE_HOST         optional, defaults to https://cloud.langfuse.com
 *                         (EU); use https://us.cloud.langfuse.com for US.
 *
 * Without both keys the plugin does nothing. Export errors never break the
 * session: they are logged to stderr (visible in the sandbox logs) and dropped.
 */

import { createHash } from "node:crypto";

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;
const MAX_TEXT_CHARS = 20000;
const MAX_LOGGED_ERRORS = 5;

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

function hexId(seed, length) {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function nanos(ms) {
  return `${BigInt(Math.round(ms ?? Date.now())) * 1000000n}`;
}

function attribute(key, value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: `${value}` } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: `${v}` })) } } };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { key, value: { stringValue: truncate(text) } };
}

function attributes(entries) {
  return Object.entries(entries)
    .map(([key, value]) => attribute(key, value))
    .filter(Boolean);
}

export const LangfusePlugin = async () => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return {};

  const host = (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const endpoint = `${host}/api/public/otel/v1/traces`;
  const authHeader = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const openInspectSessionId = readOpenInspectSession();
  const repo =
    process.env.REPO_OWNER && process.env.REPO_NAME
      ? `${process.env.REPO_OWNER}/${process.env.REPO_NAME}`
      : undefined;

  console.error(`[langfuse] plugin loaded, exporting to ${endpoint}`);

  const queue = [];
  let flushing = null;
  let loggedErrors = 0;

  // OpenCode session -> current turn { traceId, rootSpanId, start, input, output }
  const turns = new Map();
  // assistant message id -> { partId -> text }
  const assistantText = new Map();
  // tool call id -> start time
  const toolStarts = new Map();

  function logError(message) {
    if (loggedErrors >= MAX_LOGGED_ERRORS) return;
    loggedErrors += 1;
    console.error(`[langfuse] ${message}`);
  }

  function traceAttributes(sessionID) {
    return {
      "langfuse.session.id": openInspectSessionId ?? sessionID,
      "langfuse.trace.tags": ["open-inspect", "opencode"],
      "langfuse.trace.metadata.repository": repo,
      "langfuse.trace.metadata.opencode_session_id": sessionID,
    };
  }

  function emit(span) {
    queue.push(span);
    if (queue.length >= MAX_BATCH_SIZE) void flush();
  }

  async function flush() {
    if (flushing) return flushing;
    if (queue.length === 0) return;
    const spans = queue.splice(0, queue.length);
    flushing = (async () => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: authHeader },
          body: JSON.stringify({
            resourceSpans: [
              {
                resource: { attributes: attributes({ "service.name": "opencode" }) },
                scopeSpans: [{ scope: { name: "open-inspect-langfuse" }, spans }],
              },
            ],
          }),
        });
        if (!response.ok) {
          logError(`export failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
        }
      } catch (error) {
        logError(`export failed: ${error?.message ?? error}`);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref?.();

  function endTurn(sessionID) {
    const turn = turns.get(sessionID);
    if (!turn) return;
    turns.delete(sessionID);
    emit({
      traceId: turn.traceId,
      spanId: turn.rootSpanId,
      name: repo ? `opencode ${repo}` : "opencode",
      kind: 1,
      startTimeUnixNano: nanos(turn.start),
      endTimeUnixNano: nanos(),
      attributes: attributes({
        ...traceAttributes(sessionID),
        "langfuse.trace.name": repo ? `opencode ${repo}` : "opencode",
        "langfuse.trace.input": turn.input,
        "langfuse.trace.output": turn.output,
        "langfuse.observation.type": "agent",
        "langfuse.observation.input": turn.input,
        "langfuse.observation.output": turn.output,
      }),
      status: { code: 1 },
    });
  }

  function messageOutput(messageID) {
    const parts = assistantText.get(messageID);
    if (!parts) return undefined;
    return truncate([...parts.values()].join("\n").trim()) || undefined;
  }

  return {
    "chat.message": async (input, output) => {
      const turnKey = output.message?.id ?? input.messageID;
      if (!turnKey) return;
      endTurn(input.sessionID);
      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n");
      turns.set(input.sessionID, {
        traceId: hexId(`trace:${turnKey}`, 32),
        rootSpanId: hexId(`root:${turnKey}`, 16),
        start: output.message?.time?.created ?? Date.now(),
        input: truncate(prompt),
        output: undefined,
      });
    },

    "tool.execute.before": async (input) => {
      toolStarts.set(input.callID, Date.now());
    },

    "tool.execute.after": async (input, output) => {
      const turn = turns.get(input.sessionID);
      if (!turn) return;
      const startedAt = toolStarts.get(input.callID) ?? Date.now();
      toolStarts.delete(input.callID);
      emit({
        traceId: turn.traceId,
        spanId: hexId(`tool:${input.callID}`, 16),
        parentSpanId: turn.rootSpanId,
        name: `tool:${input.tool}`,
        kind: 1,
        startTimeUnixNano: nanos(startedAt),
        endTimeUnixNano: nanos(),
        attributes: attributes({
          ...traceAttributes(input.sessionID),
          "langfuse.observation.type": "tool",
          "langfuse.observation.input": input.args,
          "langfuse.observation.output": output?.output,
          "langfuse.observation.metadata.title": output?.title,
        }),
        status: { code: 1 },
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
        const turn = turns.get(info.sessionID);
        const text = messageOutput(info.id);
        assistantText.delete(info.id);
        if (!turn) return;
        if (text) turn.output = text;
        const tokens = info.tokens ?? {};
        emit({
          traceId: turn.traceId,
          spanId: hexId(`gen:${info.id}`, 16),
          parentSpanId: turn.rootSpanId,
          name: `${info.providerID}/${info.modelID}`,
          kind: 3,
          startTimeUnixNano: nanos(info.time.created),
          endTimeUnixNano: nanos(info.time.completed),
          attributes: attributes({
            ...traceAttributes(info.sessionID),
            "langfuse.observation.type": "generation",
            "langfuse.observation.model.name": info.modelID,
            "gen_ai.system": info.providerID,
            "gen_ai.request.model": info.modelID,
            "gen_ai.usage.input_tokens": tokens.input ?? 0,
            "gen_ai.usage.output_tokens": tokens.output ?? 0,
            "langfuse.observation.usage_details": {
              input: tokens.input ?? 0,
              output: tokens.output ?? 0,
              reasoning: tokens.reasoning ?? 0,
              cache_read_input_tokens: tokens.cache?.read ?? 0,
              cache_creation_input_tokens: tokens.cache?.write ?? 0,
            },
            "langfuse.observation.cost_details":
              typeof info.cost === "number" ? { total: info.cost } : undefined,
            "langfuse.observation.output": text,
            "langfuse.observation.level": info.error ? "ERROR" : undefined,
            "langfuse.observation.status_message": info.error
              ? info.error.data?.message ?? info.error.name
              : undefined,
            "langfuse.observation.metadata.finish": info.finish,
          }),
          status: info.error ? { code: 2 } : { code: 1 },
        });
        return;
      }

      if (event.type === "session.idle") {
        endTurn(event.properties.sessionID);
        await flush();
      }
    },

    dispose: async () => {
      clearInterval(timer);
      for (const sessionID of [...turns.keys()]) endTurn(sessionID);
      await flush();
    },
  };
};
