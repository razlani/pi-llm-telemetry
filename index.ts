import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { appendFileSync } from "node:fs";
import { TelemetryEngine } from "./engine";
import { renderStatus } from "./ui";

const STATUS_KEY = "llmTelemetry";
const DEBUG_LOG = "/tmp/pi-telemetry-debug.log";
const dbg = (msg: string) => { try { appendFileSync(DEBUG_LOG, `${Date.now()} [index] ${msg}\n`); } catch {} };

export default (pi: ExtensionAPI) => {
  const engine = new TelemetryEngine();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  dbg("extension loaded");

  // Preserve thinking traces in conversation history to prevent KV cache prefix mismatch.
  // Without this, Pi strips empty <think></think> tags from assistant responses between
  // turns, causing the token sequence to diverge from what's in the server's KV cache.
  //
  // `enable_thinking` and `preserve_thinking` are INDEPENDENT:
  //   preserve_thinking -> keep think tags in history so re-tokenization matches the KV cache
  //   enable_thinking   -> whether the model reasons at all before answering
  // This hook shipped with `enable_thinking: false` (2026-06-10, commit e7fb5eb) and, because
  // it runs on before_provider_request and spreads-then-overrides, it silently beat the
  // `reasoning: true` / `thinkingFormat: "qwen-chat-template"` settings in models.json — so
  // Qwen3.6 ran with reasoning fully disabled while the runbook claimed thinking was on.
  // A/B on the docker/iptables trap prompt (2026-08-06): thinking off produced a muddled
  // bridge-isolation explanation; thinking on produced the decisive "a firewall drop would be a
  // timeout, not a DNS failure" step plus a correct fix. Cost is ~2x completion tokens.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const kwargs = (payload.chat_template_kwargs as Record<string, unknown>) ?? {};
    return {
      ...payload,
      chat_template_kwargs: {
        ...kwargs,
        enable_thinking: true,
        clear_thinking: false,
        preserve_thinking: true,
      },
    };
  });

  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  pi.on("session_start", async (_, ctx: ExtensionContext) => {
    dbg("session_start fired");
    engine.init();
    renderStatus(ctx, engine, STATUS_KEY);
  });

  pi.on("message_start", async (event, ctx: ExtensionContext) => {
    dbg(`message_start role=${event.message?.role}`);
    if (event.message?.role === "assistant") {
      engine.markRequestStart();
      clearPoll();
      pollTimer = setInterval(() => renderStatus(ctx, engine, STATUS_KEY), 500);
    }
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    dbg(`message_end role=${event.message?.role}`);
    clearPoll();
    if (event.message?.role !== "assistant") return;

    const tryRead = (retries: number) => {
      dbg(`tryRead retries=${retries}`);
      const found = engine.readLatestTimings();
      dbg(`tryRead found=${found}`);
      if (!found && retries > 0) {
        retryTimer = setTimeout(() => { retryTimer = null; tryRead(retries - 1); }, 250);
        return;
      }
      if (engine.isCacheMiss) emitCacheMissWarning(ctx);
      renderStatus(ctx, engine, STATUS_KEY);
    };

    tryRead(8);
  });

  const emitCacheMissWarning = (ctx: ExtensionContext) => {
    const t = engine.lastTimings!;
    const costSec = (t.promptMs / 1000).toFixed(1);
    const median = engine.medianPromptN;
    // Fired from a deferred retry, so ctx may be stale (see setStatus note in ui.ts).
    try {
      ctx.ui.notify(
        `WARNING: CACHE MISS — full re-prefill ${t.promptN} tokens (${costSec}s). ` +
        `Expected delta ~${median}. Check: server restart? message reformat? context reset?`,
        "warning",
      );
    } catch {
      /* stale ctx after session replacement — drop this notification */
    }
  };

  pi.on("turn_end", async (_, ctx: ExtensionContext) => {
    clearPoll();
    renderStatus(ctx, engine, STATUS_KEY);
  });

  pi.on("session_shutdown", async () => {
    clearPoll();
  });
};
