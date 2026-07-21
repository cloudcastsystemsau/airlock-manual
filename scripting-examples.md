# Scripting examples (AIR-118)

Worked examples for the runtime scripting engine (AIR-57..68), one set per
language. Each is also available in the console: **Scripting → New script →
Examples** inserts it into the editor. Every example here is compile-validated
against the real engines by `ScriptExampleTests` — if the host API changes,
those tests fail before this page can go stale.

## The `air` API

One language-agnostic host surface (`IScriptHost`) is bound per script — Lua
calls it as `air:Method(...)`, JavaScript as `air.Method(...)`, and C# scripts
have the members directly in scope as globals. All state-changing calls run
through the same gated control path as REST (state-legality, licence, audit —
principal = the script name) and **return `false` when refused** rather than
throwing.

| Area | Methods | Notes |
|---|---|---|
| Diagnostics | `Log(level, message)` | levels `debug` `info` `warn` `error`; streams to the live script log |
| One-shots (AIR-151) | `After(delayMs, identifier)` `CancelAfter(identifier)` | named, replace-on-reschedule; fires the `scriptDelayed` trigger |
| Persistent vars | `GetVar(name)` `SetVar(name, value)` `DeleteVar(name)` | LiteDB-backed strings; survive restarts; shared across scripts (CleanStream model) |
| Video delay | `Build(ch)` `Rollout(ch)` `Dump(ch)` `SetFreeze(ch, on)` `Trigger(ch, templateId[, overrides])`¹ | commands, gated like REST |
| Video status | `State(ch)` `Depth(ch)` `Alarms(ch)` | `State` = `Live/Building/Delayed/RollingOut` ("" = no such channel); `Depth` in frames (−1 unknown); `Alarms` = active alarm ids |
| Audio delay | `AudioBuild(ch)` `AudioDump(ch)` `AudioDumpAll(ch)` `AudioCough(ch)` `AudioExit(ch)` | AIR-55 IPC to the audio child |
| Audio status | `AudioState(ch)` | `Idle/Building/InDelay/Exiting` ("" = not an audio channel) |
| Encoders | `EncoderEnable(ch)` `EncoderDisable(ch)` `EncoderReconfigure(ch)` `EncoderRunning(ch)` | |

¹ C# names it `Trig(ch, templateId)` (`Trigger` is the trigger-kind global there).

## Triggers ("native timing")

Timing comes from the trigger binding, not the language: bind **timer**
(fixed interval in ms) for periodic work, **schedule** (cron expression, e.g.
`0 2 * * *`) for calendar work, plus `startup`/`shutdown`, `channelEvent` /
`audioEvent` / `encoderEvent`, `gpi`, and the data triggers `dataReceived` /
`dataClientEvent` / `dataDelayed` (AIR-82/86).

Entry signature (Lua/JS; C# runs the whole body with globals):

```
main(trigger, channel, event, args)
```

`args` carries the trigger payload — for `dataReceived`:
`args.receiver` (name), `args.source` (remote endpoint), `args.data`
(**the payload bytes decoded as UTF-8 text**). There is no separate binary
path: non-UTF-8 bytes arrive as replacement characters, so prefer text
protocols (JSON/XML/delimited) for external data sources.

## The examples

The canonical sources live in `web/Airlock.Web/src/scriptExamples.ts` (what the
console inserts). Per language they cover:

| Example | Trigger | Shows |
|---|---|---|
| Timer + persistent counter | `timer` | interval work; `GetVar`/`SetVar` state across runs and restarts |
| Cron schedule (nightly build) | `schedule` | cron timing; checking `AudioState` before acting |
| Delay status watchdog | `timer` | `State`/`Depth`/`Alarms`/`AudioState`/`EncoderRunning` sweep with warn logs |
| Control delays (GPI dump-all) | `gpi` | coordinated video `Dump` + `AudioDump`, honouring the boolean refusals |
| Parse JSON | `dataReceived` | JS: native `JSON.parse`; Lua: pattern extraction; C#: string-ops extraction (sandbox imports only System/Linq/Collections) |
| Parse XML | `dataReceived` | tag-value extraction (no DOM/XML parser inside any sandbox) |
| Delimited / binary | `dataReceived` | split on delimiters; opcode inspection via `string.byte` / `charCodeAt` / `(int)ch`, with the UTF-8 caveat above |

Sandbox limits worth remembering: Lua has no `os`/`io`/`require` (string/table/
math remain); Jint exposes no CLR or filesystem (but has real `JSON`); C# script
bodies compile against `System`, `System.Linq` and `System.Collections.Generic`
only. Long loops are cut off by the per-invocation timeout in all three.
