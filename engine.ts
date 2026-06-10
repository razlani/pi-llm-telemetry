import { readFileSync, statSync, appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/llama-server.log";
const DEBUG_LOG = "/tmp/pi-telemetry-debug.log";
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
  private _totalDraftAccepted = 0;
  private _totalDraftGenerated = 0;
  private _pendingLogData = "";

  get lastTimings() { return this._lastTimings; }
  get isCacheMiss() { return this._isCacheMiss; }
  get dataPoints() { return this._dataPoints; }

  get sessionMtpRate(): number | null {
    if (this._totalDraftGenerated === 0) return null;
    return this._totalDraftAccepted / this._totalDraftGenerated;
  }

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

  private _debugLog(msg: string) {
    try { appendFileSync(DEBUG_LOG, `${Date.now()} ${msg}\n`); } catch {}
  }

  init() {
    try {
      const stat = statSync(LOG_PATH);
      this._logOffset = stat.size;
      this._debugLog(`init: offset=${this._logOffset}`);
    } catch {
      this._logOffset = 0;
      this._debugLog(`init: log not found, offset=0`);
    }
  }

  markRequestStart() {
    this._requestStartTime = Date.now();
    this._pendingLogData = "";
  }

  readLatestTimings(): boolean {
    this._requestStartTime = 0;

    try {
      const stat = statSync(LOG_PATH);
      const newBytes = stat.size - this._logOffset;
      if (newBytes <= 0) {
        this._logOffset = stat.size;
        this._debugLog(`no new data (offset=${this._logOffset}, size=${stat.size})`);
        return this._pendingLogData.length > 0 ? this._tryParsePending() : false;
      }
      this._debugLog(`reading ${newBytes} bytes from offset ${this._logOffset}`);
      const buf = Buffer.alloc(Math.min(newBytes, 16384));
      const fd = require("node:fs").openSync(LOG_PATH, "r");
      try {
        require("node:fs").readSync(fd, buf, 0, buf.length, this._logOffset);
      } finally {
        require("node:fs").closeSync(fd);
      }
      this._logOffset = stat.size;
      this._pendingLogData += buf.toString("utf-8");
    } catch (e) {
      this._debugLog(`read error: ${e}`);
      return false;
    }

    return this._tryParsePending();
  }

  private _tryParsePending(): boolean {
    const snapshot = this.parseTimings(this._pendingLogData);
    if (!snapshot) {
      this._debugLog(`no complete block in pending (${this._pendingLogData.length} bytes, tail: ${this._pendingLogData.slice(-120)})`);
      return false;
    }
    this._pendingLogData = "";

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

    if (snapshot.draftAccepted !== null && snapshot.draftGenerated !== null) {
      this._totalDraftAccepted += snapshot.draftAccepted;
      this._totalDraftGenerated += snapshot.draftGenerated;
    }

    // Cache miss detection (skip first 3 data points — cold start)
    // Use ratio-based detection: a miss is when most of n_past was re-prefilled,
    // NOT when the absolute delta is large (a big legitimate delta with good
    // prefix reuse is not a miss).
    this._isCacheMiss = false;
    if (this._dataPoints > 3 && snapshot.nPast > 0) {
      const ratio = snapshot.promptN / snapshot.nPast;
      if (ratio > 0.8 && snapshot.promptN > MISS_FLOOR) {
        this._isCacheMiss = true;
      }
    }
    return true;
  }

  private parseTimings(text: string): TimingSnapshot | null {
    // Split log into per-request blocks. Each block ends with a release_slots line.
    // Parse the LAST complete block (prompt eval + optional gen eval + release_slots).
    const lines = text.split("\n");
    let lastBlock: string[] = [];
    let currentBlock: string[] = [];

    for (const line of lines) {
      currentBlock.push(line);
      if (line.includes("release_slots")) {
        lastBlock = currentBlock;
        currentBlock = [];
      }
    }

    if (lastBlock.length === 0) return null;
    const block = lastBlock.join("\n");

    // Parse prompt eval from this block
    const pm = block.match(
      /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*[\d.]+\s*ms per token,\s*([\d.]+)\s*tokens per second\)/
    );
    if (!pm) return null;

    // Parse gen eval from this block
    let predictedN = 0, predictedMs = 0, predictedPerSecond = 0;
    const gm = block.match(
      /(?<!prompt )eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*[\d.]+\s*ms per token,\s*([\d.]+)\s*tokens per second\)/
    );
    if (gm) {
      predictedMs = parseFloat(gm[1]);
      predictedN = parseInt(gm[2], 10);
      predictedPerSecond = parseFloat(gm[3]);
    }

    // Parse release_slots from this block
    let nPast = 0, nCacheTokens = 0;
    const rm = block.match(
      /release_slots.*?n_past=(\d+).*?n_cache_tokens=(\d+)/
    );
    if (rm) {
      nPast = parseInt(rm[1], 10);
      nCacheTokens = parseInt(rm[2], 10);
    }

    // Parse MTP draft acceptance from this block (ik_llama only)
    let draftAccepted: number | null = null;
    let draftGenerated: number | null = null;
    const dm = block.match(
      /draft acceptance rate\s*=\s*[\d.]+\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\)/
    );
    if (dm) {
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
