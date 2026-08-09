import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelemetryEngine } from "./engine";

const ESC = "\x1b";
const RED = `${ESC}[38;2;255;68;68m`;
const GREEN = `${ESC}[38;2;0;255;136m`;
const YELLOW = `${ESC}[38;2;255;170;0m`;
const CYAN = `${ESC}[38;2;68;221;255m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;

const dim = (s: string) => `${DIM}${s}${RESET}`;
const red = (s: string) => `${RED}${BOLD}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const yellow = (s: string) => `${YELLOW}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const fmt = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
};

// Status writes are driven by timers (poll interval + message_end retries), so they can
// land after the session they captured `ctx` from has been replaced. Since pi 0.83.0 the
// extension runner throws on `ctx.ui` access for a stale ctx, and an uncaught throw from a
// timer callback kills the whole process. Swallow it — a dropped status line is harmless.
const setStatus = (ctx: ExtensionContext, key: string, value: string): void => {
  try {
    ctx.ui.setStatus(key, value);
  } catch {
    /* stale ctx after session replacement — drop this frame */
  }
};

export const renderStatus = (
  ctx: ExtensionContext,
  engine: TelemetryEngine,
  key: string,
): void => {
  const t = engine.lastTimings;

  if (!t && !engine.isPrefilling) {
    setStatus(ctx, key, dim("Telemetry: waiting..."));
    return;
  }

  if (engine.isPrefilling) {
    const elapsed = (engine.prefillElapsedMs / 1000).toFixed(1);
    setStatus(ctx, key, dim(`prefilling ${elapsed}s...`));
    return;
  }

  if (!t) return;

  const parts: string[] = [];

  // Cache: per-request hit% + session avg, with recent miss indicator
  if (engine.isCacheMiss) {
    parts.push(red(`MISS ${fmt(t.promptN)} reprefilled`));
  } else if (t.nPast > 0) {
    const hitPct = Math.round((1 - t.promptN / t.nPast) * 100);
    const sessionAvg = engine.sessionCacheHitPct;
    const cacheColor = hitPct >= 95 ? green : hitPct >= 50 ? yellow : red;
    let cacheStr = cacheColor(`${hitPct}%`);
    if (sessionAvg >= 0 && sessionAvg !== hitPct) {
      const avgColor = sessionAvg >= 90 ? green : sessionAvg >= 70 ? yellow : red;
      cacheStr += dim("/") + avgColor(`avg ${sessionAvg}%`);
    }
    // Recent miss indicator (fades after 60s)
    const missAgo = engine.lastMissSecondsAgo;
    if (missAgo >= 0 && missAgo < 60) {
      cacheStr += " " + red(`↓${missAgo}s ago`);
    }
    parts.push(dim("cache ") + cacheStr);
  }

  // Prefill speed
  if (t.promptPerSecond > 0) {
    const ppColor = t.promptPerSecond >= 1500 ? green : t.promptPerSecond >= 500 ? cyan : yellow;
    parts.push(dim("pp ") + ppColor(`${fmt(t.promptPerSecond)}`));
  }

  // Gen speed
  if (t.predictedPerSecond > 0) {
    const genColor = t.predictedPerSecond >= 90 ? green : t.predictedPerSecond >= 60 ? yellow : red;
    parts.push(dim("gen ") + genColor(`${fmt(t.predictedPerSecond)}`));
  }

  // MTP: "mtp 61%/avg 74%"
  if (t.draftGenerated !== null && t.draftAccepted !== null && t.draftGenerated > 0) {
    const rate = t.draftAccepted / t.draftGenerated;
    const pct = Math.round(rate * 100);
    const sessionRate = engine.sessionMtpRate;
    const sessionPct = sessionRate !== null ? Math.round(sessionRate * 100) : null;
    const displayRate = sessionRate ?? rate;
    const mtpColor = displayRate >= 0.73 ? cyan : displayRate >= 0.58 ? yellow : red;
    const label = sessionPct !== null && sessionPct !== pct
      ? `${pct}%${dim("/")}avg ${sessionPct}%`
      : `${pct}%`;
    parts.push(dim("mtp ") + mtpColor(label));
  }

  setStatus(ctx, key, parts.join(dim(" | ")));
};
