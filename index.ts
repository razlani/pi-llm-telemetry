import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { TelemetryEngine } from "./engine";
import { renderStatus } from "./ui";

const STATUS_KEY = "llmTelemetry";

export default (pi: ExtensionAPI) => {
  const engine = new TelemetryEngine();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  pi.on("session_start", async (_, ctx: ExtensionContext) => {
    engine.init();
    renderStatus(ctx, engine, STATUS_KEY);
  });

  pi.on("message_start", async (event, ctx: ExtensionContext) => {
    if (event.message?.role === "assistant") {
      engine.markRequestStart();
      clearPoll();
      pollTimer = setInterval(() => renderStatus(ctx, engine, STATUS_KEY), 500);
    }
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    clearPoll();
    if (event.message?.role !== "assistant") return;

    const tryRead = (retries: number) => {
      const found = engine.readLatestTimings();
      if (!found && retries > 0) {
        setTimeout(() => tryRead(retries - 1), 150);
        return;
      }
      if (engine.isCacheMiss) emitCacheMissWarning(ctx);
      renderStatus(ctx, engine, STATUS_KEY);
    };

    tryRead(3);
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
