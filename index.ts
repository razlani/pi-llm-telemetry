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
  dbg("extension loaded");

  // Preserve thinking traces in conversation history to prevent KV cache prefix mismatch.
  // Without this, Pi strips empty <think></think> tags from assistant responses between
  // turns, causing the token sequence to diverge from what's in the server's KV cache.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const kwargs = (payload.chat_template_kwargs as Record<string, unknown>) ?? {};
    return {
      ...payload,
      chat_template_kwargs: {
        ...kwargs,
        enable_thinking: false,
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
        setTimeout(() => tryRead(retries - 1), 250);
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
    ctx.ui.notify(
      `WARNING: CACHE MISS — full re-prefill ${t.promptN} tokens (${costSec}s). ` +
      `Expected delta ~${median}. Check: server restart? message reformat? context reset?`,
      "warning",
    );
  };

  pi.on("turn_end", async (_, ctx: ExtensionContext) => {
    clearPoll();
    renderStatus(ctx, engine, STATUS_KEY);
  });

  pi.on("session_shutdown", async () => {
    clearPoll();
  });
};
