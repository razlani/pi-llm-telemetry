import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { TelemetryEngine } from "./engine";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function appendLog(content: string) {
  const { appendFileSync } = require("node:fs");
  appendFileSync(REAL_LOG, content);
}

// Patch LOG_PATH for testing — we need to override the constant
// Since the engine hardcodes /tmp/llama-server.log, we'll write there
// and save/restore the original content
const REAL_LOG = "/tmp/llama-server.log";
const { readFileSync } = require("node:fs");
let originalLog: Buffer | null = null;
try { originalLog = readFileSync(REAL_LOG); } catch {}

function restoreLog() {
  if (originalLog) writeFileSync(REAL_LOG, originalLog);
}

// --- Tests ---

console.log("=== pi-llm-telemetry engine tests ===\n");

// Test 1: Parse prompt eval line
console.log("Test 1: Parse prompt eval timing");
{
  const logContent = `INFO [   launch_slot_with_task] slot is processing task | tid="131648099241984" timestamp=1780659424 id_slot=0 id_task=8
slot print_timing: id  0 | task 8 |${" "}
prompt eval time =      89.83 ms /    19 tokens (    4.73 ms per token,   211.51 tokens per second)
eval time =      48.30 ms /     5 tokens (    9.66 ms per token,   103.52 tokens per second)
draft acceptance rate = 1.00000 (    2 accepted /     2 generated)
INFO [           release_slots] slot released | tid="131648099241984" timestamp=1780659424 id_slot=0 id_task=8 n_ctx=131072 n_past=27 n_system_tokens=0 n_cache_tokens=27 truncated=false
`;
  writeFileSync(REAL_LOG, logContent);
  const engine = new TelemetryEngine();
  engine.init();
  // Reset offset to 0 so it reads the whole file
  (engine as any)._logOffset = 0;
  engine.readLatestTimings();
  const t = engine.lastTimings;

  assert(t !== null, "should parse timings");
  assert(t!.promptN === 19, `promptN should be 19, got ${t!.promptN}`);
  assert(Math.abs(t!.promptMs - 89.83) < 0.01, `promptMs should be 89.83, got ${t!.promptMs}`);
  assert(Math.abs(t!.promptPerSecond - 211.51) < 0.01, `promptPerSecond should be 211.51, got ${t!.promptPerSecond}`);
  assert(t!.predictedN === 5, `predictedN should be 5, got ${t!.predictedN}`);
  assert(Math.abs(t!.predictedPerSecond - 103.52) < 0.01, `predictedPerSecond should be ~103.52, got ${t!.predictedPerSecond}`);
  assert(t!.nPast === 27, `nPast should be 27, got ${t!.nPast}`);
  assert(t!.nCacheTokens === 27, `nCacheTokens should be 27, got ${t!.nCacheTokens}`);
  assert(t!.draftAccepted === 2, `draftAccepted should be 2, got ${t!.draftAccepted}`);
  assert(t!.draftGenerated === 2, `draftGenerated should be 2, got ${t!.draftGenerated}`);
  assert(engine.dataPoints === 1, "dataPoints should be 1");
}

// Test 2: No false alerts on cold start (< 3 data points)
console.log("Test 2: No false alert on cold start");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  // First request — large prompt_n (full context, cold start)
  const coldLog = `prompt eval time =   25000.00 ms / 80000 tokens (    0.31 ms per token,  3200.00 tokens per second)
INFO [           release_slots] slot released | n_past=80000 n_cache_tokens=80000
`;
  appendLog(coldLog);
  engine.readLatestTimings();
  assert(!engine.isCacheMiss, "cold start (1st request) should not alert");

  // Second request — still building up
  appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=81000 n_cache_tokens=81000
`);
  engine.readLatestTimings();
  assert(!engine.isCacheMiss, "2nd request should not alert");

  // Third request
  appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=82000 n_cache_tokens=82000
`);
  engine.readLatestTimings();
  assert(!engine.isCacheMiss, "3rd request should not alert");
  assert(engine.dataPoints === 3, "should have 3 data points");
}

// Test 3: Cache miss detection after warm-up
console.log("Test 3: Cache miss detection");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  // Build up 5 normal requests with small prompt_n
  for (let i = 0; i < 5; i++) {
    appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=${20000 + i * 500} n_cache_tokens=${20000 + i * 500}
`);
    engine.readLatestTimings();
  }
  assert(!engine.isCacheMiss, "normal requests should not alert");
  assert(engine.medianPromptN === 500, `median should be 500, got ${engine.medianPromptN}`);

  // Now a cache miss — full re-prefill
  appendLog(`prompt eval time =   25000.00 ms / 80000 tokens (    0.31 ms per token,  3200.00 tokens per second)
INFO [           release_slots] slot released | n_past=80000 n_cache_tokens=80000
`);
  engine.readLatestTimings();
  assert(engine.isCacheMiss, "80k prompt_n after median 500 should trigger cache miss");
  assert(engine.lastTimings!.promptN === 80000, "should capture the 80k prompt_n");
}

// Test 4: No false alert on small context (prompt_n < 5000 floor)
console.log("Test 4: Small context — no false alert even with spike");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  for (let i = 0; i < 5; i++) {
    appendLog(`prompt eval time =      10.00 ms /    50 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=${200 + i * 50} n_cache_tokens=${200 + i * 50}
`);
    engine.readLatestTimings();
  }

  // "Spike" to 2000 — exceeds 10x median (50) but under 5000 floor
  appendLog(`prompt eval time =     400.00 ms /  2000 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=2000 n_cache_tokens=2000
`);
  engine.readLatestTimings();
  assert(!engine.isCacheMiss, "2000 tokens exceeds 10x median but under 5000 floor — no alert");
}

// Test 5: Rolling window caps at 20
console.log("Test 5: Rolling window size");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  for (let i = 0; i < 25; i++) {
    appendLog(`prompt eval time =     100.00 ms /   ${100 + i} tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=${1000 + i * 100} n_cache_tokens=${1000 + i * 100}
`);
    engine.readLatestTimings();
  }
  assert((engine as any)._promptNHistory.length === 20, `rolling window should cap at 20, got ${(engine as any)._promptNHistory.length}`);
  assert(engine.dataPoints === 25, "dataPoints should count all 25");
}

// Test 6: No MTP data on mainline llama.cpp
console.log("Test 6: Mainline llama.cpp (no MTP)");
{
  const logContent = `prompt eval time =      89.83 ms /    19 tokens (    4.73 ms per token,   211.51 tokens per second)
eval time =      48.30 ms /     5 tokens (    9.66 ms per token,   103.52 tokens per second)
INFO [           release_slots] slot released | n_past=27 n_cache_tokens=27
`;
  writeFileSync(REAL_LOG, logContent);
  const engine = new TelemetryEngine();
  engine.init();
  (engine as any)._logOffset = 0;
  engine.readLatestTimings();
  const t = engine.lastTimings;

  assert(t !== null, "should parse without MTP");
  assert(t!.draftAccepted === null, "draftAccepted should be null without MTP");
  assert(t!.draftGenerated === null, "draftGenerated should be null without MTP");
}

// Test 7: Log truncation handling (server restart)
console.log("Test 7: Log truncation (server restart)");
{
  writeFileSync(REAL_LOG, "x".repeat(10000));
  const engine = new TelemetryEngine();
  engine.init();
  // Offset is now at 10000

  // Server restarts — log is smaller
  writeFileSync(REAL_LOG, `prompt eval time =      50.00 ms /    10 tokens (    5.00 ms per token,   200.00 tokens per second)
INFO [           release_slots] slot released | n_past=10 n_cache_tokens=10
`);
  engine.readLatestTimings();
  // Should handle gracefully — either read from 0 or skip
  // The engine detects size < offset and resets
  assert(engine.dataPoints <= 1, "should handle log truncation without crash");
}

// Test 8: Average calculations
console.log("Test 8: Rolling averages");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  2000.00 tokens per second)
eval time =     100.00 ms /    10 tokens (   10.00 ms per token,   100.00 tokens per second)
INFO [           release_slots] slot released | n_past=500 n_cache_tokens=500
`);
  engine.readLatestTimings();

  appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  4000.00 tokens per second)
eval time =     100.00 ms /    10 tokens (   10.00 ms per token,   200.00 tokens per second)
INFO [           release_slots] slot released | n_past=1000 n_cache_tokens=1000
`);
  engine.readLatestTimings();

  assert(Math.abs(engine.avgPrefillSpeed - 3000) < 0.1, `avg prefill should be 3000, got ${engine.avgPrefillSpeed}`);
  assert(Math.abs(engine.avgGenSpeed - 150) < 0.1, `avg gen should be 150, got ${engine.avgGenSpeed}`);
}

// Test 9: Cache miss resets on next good request
console.log("Test 9: Cache miss flag resets");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();

  for (let i = 0; i < 5; i++) {
    appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=${20000 + i * 500} n_cache_tokens=${20000 + i * 500}
`);
    engine.readLatestTimings();
  }

  // Cache miss
  appendLog(`prompt eval time =   25000.00 ms / 80000 tokens (    0.31 ms per token,  3200.00 tokens per second)
INFO [           release_slots] slot released | n_past=80000 n_cache_tokens=80000
`);
  engine.readLatestTimings();
  assert(engine.isCacheMiss, "should be cache miss");

  // Next normal request
  appendLog(`prompt eval time =     100.00 ms /   500 tokens (    0.20 ms per token,  5000.00 tokens per second)
INFO [           release_slots] slot released | n_past=81000 n_cache_tokens=81000
`);
  engine.readLatestTimings();
  assert(!engine.isCacheMiss, "should reset after normal request");
}

// Test 10: Empty log — no crash
console.log("Test 10: Empty/missing log");
{
  writeFileSync(REAL_LOG, "");
  const engine = new TelemetryEngine();
  engine.init();
  engine.readLatestTimings();
  assert(engine.lastTimings === null, "should be null on empty log");
  assert(engine.dataPoints === 0, "zero data points");
}

// --- Cleanup ---
restoreLog();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
