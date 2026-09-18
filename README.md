# pi-llm-telemetry

Live inference telemetry in the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
status bar for a local `llama.cpp` / `ik_llama.cpp` server: prompt-cache hit rate, prefill and
generation throughput, speculative-decoding acceptance, and a loud warning the moment your cache
is invalidated.

```
cache 97%/avg 94% | pp 3.1k | gen 131 | mtp 74%/avg 72%
```

## Why

On a local server the thing that decides whether a long agent session feels instant or unusable is
the **prompt cache**. A cache hit re-prefills nothing. A miss re-prefills the entire context, which
on a 100k-token conversation is tens of seconds of dead time before a single token comes back.

The problem is that a miss is invisible. The model still answers, just slowly, and the cost is
buried in the server log. This extension surfaces it while you are working, and tells you
immediately when a turn paid the full re-prefill price so you can find out why (server restarted?
history reformatted? context reset?) instead of quietly living with it.

## What the status bar shows

| Field | Meaning |
|---|---|
| `cache 97%` | prompt-cache hit rate for the last request, with a session average |
| `MISS 84k reprefilled` | the last request re-prefilled from scratch, in red |
| `↓12s ago` | a miss happened recently, shown for 60s afterwards |
| `pp 3.1k` | prefill throughput, server-reported tokens/sec |
| `gen 131` | generation throughput, tokens/sec |
| `mtp 74%` | speculative-decoding (MTP) draft acceptance rate, with session average |
| `prefilling 4.2s...` | a prefill is in flight, with elapsed time |

Each field is colour-graded, so a degraded session is obvious without reading numbers.

A cache miss also raises a `warning` notification naming the token count, the seconds it cost, and
the delta you should have expected.

## Install

```bash
pi install git:github.com/razlani/pi-llm-telemetry
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/razlani/pi-llm-telemetry
```

## Requirements

- pi with extension support
- A local `llama.cpp` or `ik_llama.cpp` server whose stdout/stderr is written to a log file.
  Timings are read from the server's own log, not from the HTTP response, because per-request
  `n_past` / `n_cache_tokens` and draft-acceptance counters only appear there.
- MTP fields need a server built with speculative decoding and launched with `--spec-type`.
  Everything else works without it.

## Configuration

The log file is resolved on every poll, first hit wins:

1. `$PI_LLAMA_LOG` - explicit path. Set this if your server logs anywhere unusual.
2. `/tmp/llama-server-current.log` - a symlink, if your launcher maintains one.
3. Newest-mtime `/tmp/llama-server*.log`.
4. `/tmp/llama-server.log` as a last resort.

Re-resolving each poll means switching model profiles mid-session is picked up without a restart.

```bash
PI_LLAMA_LOG=/var/log/llama/server.log pi
```

## Side effect you should know about

This extension also registers a `before_provider_request` hook that sets three
`chat_template_kwargs` on **every** outbound request:

```ts
enable_thinking: true, clear_thinking: false, preserve_thinking: true
```

`preserve_thinking` is the one that matters for telemetry. Without it, pi strips empty
`<think></think>` tags out of assistant messages between turns, the re-tokenized prefix stops
matching what the server holds in its KV cache, and you get a full re-prefill on every single turn.
Keeping the tags is what makes the cache work at all for a hybrid reasoning model.

`enable_thinking: true` is bundled with it because this hook spreads-then-overrides, so it beats
anything the client computes from `models.json`. It shipped as `false` between 2026-06-10 and
2026-08-06, which silently disabled reasoning on a Qwen3 hybrid model. It is `true` now
deliberately, and costs roughly 2x completion tokens.

If your setup does not want either of these, remove the hook from `index.ts`. It is the first block
in the file. Splitting it behind a config flag is the obvious next change.

## How it works

`engine.ts` tails the server log from a byte offset, parses the per-request timing blocks, and
keeps rolling windows so it can distinguish a genuine cache miss from a large legitimate prefill.
Miss detection is ratio-based against the median prompt size rather than a fixed threshold, because
an absolute cut-off either misses real invalidations on short contexts or fires constantly on long
ones.

Offsets are per-file and reset when the resolved log path changes. Reads are buffered, so a partial
line written while the extension is mid-read does not corrupt a parse.

`ui.ts` renders. `index.ts` wires the lifecycle: poll at 500ms while a response streams, stop on
`turn_end`, and retry the log read up to 8 times after `message_end` because the server writes its
timing block slightly after the stream closes.

## Development

```bash
npx tsx test-engine.ts
```

The tests drive the engine against synthetic log fixtures, including the multi-request-per-turn
case that made an earlier version report the wrong request's numbers.

Debug tracing goes to `/tmp/pi-telemetry-debug.log`.

## License

MIT
