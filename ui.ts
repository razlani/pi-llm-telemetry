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

export const renderStatus = (
  ctx: ExtensionContext,
  engine: TelemetryEngine,
  key: string,
): void => {
  const t = engine.lastTimings;

  if (!t && !engine.isPrefilling) {
    ctx.ui.setStatus(key, dim("Telemetry: waiting..."));
    return;
  }

  if (engine.isPrefilling) {
    const elapsed = (engine.prefillElapsedMs / 1000).toFixed(1);
    ctx.ui.setStatus(key, dim(`prefilling ${elapsed}s...`));
    return;
  }

  if (!t) return;

  const parts: string[] = [];

  // Cache status (the primary value of this extension)
  if (engine.isCacheMiss) {
    parts.push(red(`CACHE MISS ${fmt(t.promptN)}/${fmt(t.nPast)}`));
  } else if (t.nPast > 0) {
    const ratio = t.promptN / t.nPast;
    const cacheColor = ratio < 0.1 ? green : ratio < 0.5 ? yellow : red;
    parts.push(cacheColor(`cache δ${fmt(t.promptN)}/${fmt(t.nPast)}`));
  }

  // Prefill speed (complements pi-token-speed which shows wall-clock; we show server-reported t/s)
  const prefillColor = t.promptPerSecond >= 2000 ? green : t.promptPerSecond >= 500 ? yellow : red;
  parts.push(prefillColor(`${fmt(t.promptPerSecond)} t/s`));

  // MTP (ik_llama only)
  if (t.draftGenerated !== null && t.draftAccepted !== null) {
    const rate = t.draftGenerated > 0 ? t.draftAccepted / t.draftGenerated : 0;
    const mtpColor = rate >= 0.8 ? cyan : rate >= 0.5 ? yellow : red;
    parts.push(dim("mtp:") + " " + mtpColor(`${t.draftAccepted}/${t.draftGenerated}`));
  }

  ctx.ui.setStatus(key, parts.join(dim(" | ")));
};
