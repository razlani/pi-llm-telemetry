import { readFileSync, statSync } from "node:fs";

const LOG_PATH = "/tmp/llama-server.log";
const ROLLING_WINDOW = 20;
const MISS_MULTIPLIER = 10;
const MISS_FLOOR = 5000;

export interface TimingSnapshot {
  promptN: number;
  promptMs: number;
  promptPerSecond: number;
  predictedN: number;
  predictedMs: number;
  predictedPerSecond: number;
  nPast: number;
  nCacheTokens: number;
  draftAccepted: number | null;
  draftGenerated: number | null;
}

export class TelemetryEngine {
  private _lastTimings: TimingSnapshot | null = null;
  private _promptNHistory: number[] = [];
  private _prefillSpeedHistory: number[] = [];
  private _genSpeedHistory: number[] = [];
  private _logOffset = 0;
  private _requestStartTime = 0;
  private _isCacheMiss = false;
  private _dataPoints = 0;

  get lastTimings() { return this._lastTimings; }
  get isCacheMiss() { return this._isCacheMiss; }
  get dataPoints() { return this._dataPoints; }

  get avgPrefillSpeed(): number {
    if (this._prefillSpeedHistory.length === 0) return 0;
    return this._prefillSpeedHistory.reduce((a, b) => a + b, 0) / this._prefillSpeedHistory.length;
  }

  get avgGenSpeed(): number {
    if (this._genSpeedHistory.length === 0) return 0;
    return this._genSpeedHistory.reduce((a, b) => a + b, 0) / this._genSpeedHistory.length;
  }

  get medianPromptN(): number {
    if (this._promptNHistory.length === 0) return 0;
    const sorted = [...this._promptNHistory].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  get isPrefilling(): boolean {
    return this._requestStartTime > 0 && this._lastTimings === null;
  }

  get prefillElapsedMs(): number {
    if (this._requestStartTime === 0) return 0;
    return Date.now() - this._requestStartTime;
  }

  init() {
    try {
      const stat = statSync(LOG_PATH);
      this._logOffset = stat.size;
    } catch {
      this._logOffset = 0;
    }
  }

  markRequestStart() {
    this._requestStartTime = Date.now();
  }

  readLatestTimings() {
    this._requestStartTime = 0;

    let newContent: string;
    try {
      const stat = statSync(LOG_PATH);
      if (stat.size <= this._logOffset) {
        // Log was truncated or no new content
        this._logOffset = stat.size;
        return;
      }
      const buf = Buffer.alloc(Math.min(stat.size - this._logOffset, 8192));
      const fd = require("node:fs").openSync(LOG_PATH, "r");
      try {
        require("node:fs").readSync(fd, buf, 0, buf.length, this._logOffset);
      } finally {
        require("node:fs").closeSync(fd);
      }
      this._logOffset = stat.size;
      newContent = buf.toString("utf-8");
    } catch {
      return;
    }

    const snapshot = this.parseTimings(newContent);
    if (!snapshot) return;

    this._lastTimings = snapshot;
    this._dataPoints++;

    // Update rolling windows
    this._promptNHistory.push(snapshot.promptN);
    if (this._promptNHistory.length > ROLLING_WINDOW) this._promptNHistory.shift();

    if (snapshot.promptPerSecond > 0) {
      this._prefillSpeedHistory.push(snapshot.promptPerSecond);
      if (this._prefillSpeedHistory.length > ROLLING_WINDOW) this._prefillSpeedHistory.shift();
    }

    if (snapshot.predictedPerSecond > 0) {
      this._genSpeedHistory.push(snapshot.predictedPerSecond);
      if (this._genSpeedHistory.length > ROLLING_WINDOW) this._genSpeedHistory.shift();
    }

    // Cache miss detection (skip first 3 data points — cold start)
    this._isCacheMiss = false;
    if (this._dataPoints > 3) {
      const median = this.medianPromptN;
      if (snapshot.promptN > median * MISS_MULTIPLIER && snapshot.promptN > MISS_FLOOR) {
        this._isCacheMiss = true;
      }
    }
  }

  private parseTimings(text: string): TimingSnapshot | null {
    // Parse the last "prompt eval time" line
    const promptMatches = [...text.matchAll(
      /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*[\d.]+\s*ms per token,\s*([\d.]+)\s*tokens per second\)/g
    )];
    if (promptMatches.length === 0) return null;
    const pm = promptMatches[promptMatches.length - 1];

    // Parse the last "eval time" (generation) line — distinct from "prompt eval time"
    let predictedN = 0, predictedMs = 0, predictedPerSecond = 0;
    const genMatches = [...text.matchAll(
      /(?<!prompt )eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*[\d.]+\s*ms per token,\s*([\d.]+)\s*tokens per second\)/g
    )];
    if (genMatches.length > 0) {
      const gm = genMatches[genMatches.length - 1];
      predictedMs = parseFloat(gm[1]);
      predictedN = parseInt(gm[2], 10);
      predictedPerSecond = parseFloat(gm[3]);
    }

    // Parse release_slots for n_past and n_cache_tokens
    let nPast = 0, nCacheTokens = 0;
    const releaseMatches = [...text.matchAll(
      /release_slots.*?n_past=(\d+).*?n_cache_tokens=(\d+)/g
    )];
    if (releaseMatches.length > 0) {
      const rm = releaseMatches[releaseMatches.length - 1];
      nPast = parseInt(rm[1], 10);
      nCacheTokens = parseInt(rm[2], 10);
    }

    // Parse MTP draft acceptance (ik_llama only)
    let draftAccepted: number | null = null;
    let draftGenerated: number | null = null;
    const draftMatches = [...text.matchAll(
      /draft acceptance rate\s*=\s*[\d.]+\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\)/g
    )];
    if (draftMatches.length > 0) {
      const dm = draftMatches[draftMatches.length - 1];
      draftAccepted = parseInt(dm[1], 10);
      draftGenerated = parseInt(dm[2], 10);
    }

    return {
      promptN: parseInt(pm[2], 10),
      promptMs: parseFloat(pm[1]),
      promptPerSecond: parseFloat(pm[3]),
      predictedN,
      predictedMs,
      predictedPerSecond,
      nPast,
      nCacheTokens,
      draftAccepted,
      draftGenerated,
    };
  }
}
