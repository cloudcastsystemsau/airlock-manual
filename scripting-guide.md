# Airlock scripting guide (AIR-57)

Airlock lets operators automate the server at runtime by writing small scripts in
**Lua**, **JavaScript**, or **C#**. Scripts react to triggers (a channel event, a
GPI edge, a timer, a schedule, an audio-delay transition, or a manual run) and
drive video delay channels, audio profanity-delay channels, and encoders through
the same audited, licence-gated path as the console and TCP control.

Scripts run **only on the control plane** and never touch the real-time frame
path — a script can never cause a dropped frame. A misbehaving script (an error
or an infinite loop) is caught, logged to the live log, and never takes the
server down.

> **Access:** authoring is **admin-only**. Open **Scripting** in the top nav.

## Authoring a script

1. **New script** → give it a name, pick a language, choose a trigger.
2. Write the body in the editor. **Validate** compiles/parses it (you can't
   activate an invalid script). **Save version** stores an immutable version and
   makes it live.
3. **Version history** (the `v1 v2 …` chips) lets you activate/roll back to any
   earlier version; the target is re-validated before it goes live.
4. **Run** executes it immediately (the `manual` trigger); watch the **Live log**.

Every save/activate/enable/disable/delete and every state change a script makes is
written to the append-only audit as `source = script`, `principal = <script name>`.

## Entry points

- **Lua / JavaScript** define a named entry **function** — the *Entry fn* field
  (default `main`). It's called with `(trigger, channel, event, args)`:
  - `trigger` — the trigger kind (e.g. `"ChannelEvent"`, `"Gpi"`, `"Manual"`).
  - `channel` — the channel number for channel/audio/GPI triggers, else `-1`.
  - `event` — the event name (e.g. `"EnteredDelayed"`, an audio state, a GPI id).
  - `args` — a string-keyed table/object of trigger payload; `nil`/`undefined`
    when the trigger carries none (so three-parameter functions keep working).
    `dataReceived` passes `{ receiver, source, data }`; `dataClientEvent` passes
    `{ receiver, source, event = "connected" | "disconnected" }`.
- **C#** has no named entry — the **whole script body** runs each time, with the
  same context available as the globals `Trigger`, `Channel`, `Event`, and `Args`
  (an `IReadOnlyDictionary<string, string>`, empty when the trigger carries none).

## Triggers

| Kind | Fires when | Fields |
|---|---|---|
| `manual` | you press **Run** (or `POST /api/scripts/{id}/run`) | — |
| `startup` | the server starts | (entry `onstart`) |
| `shutdown` | the server stops | (entry `onstop`) |
| `channelEvent` | a **video** channel changes state | event (`EnteredBuilding`, `EnteredDelayed`, `EnteredRollingOut`, `ReturnedToLive`, `Dumped`) + optional channel |
| `audioEvent` | an **audio** delay channel changes state | state (`Idle`, `Building`, `InDelay`, `Exiting`) + optional channel |
| `encoderEvent` | an **encoder** branch transitions | state (`Running`, `Down`) + optional channel |
| `gpi` | an LWRP **GPI** pin edge | device / port / pin (each optionally *any*) + edge (`fallingEdge` default — Axia asserts low — `risingEdge`, or `both`); `args` = `{ device, port, pin, edge }`. A numeric *GPI index* instead binds the legacy abstract input. |
| `status` | a **status** level source transitions | source from the GPO mapping vocabulary (`delaySafe`, `delayFull`, `delayEmpty`, `depth10..depth100`, `inDelay`, `stateBuilding/Delayed/RollingOut/Live`, `coughActive`, `censorActive`, `postCoughActive`, `postCensorActive`, `static1..10`, `serverAlarm`) + channel (except `serverAlarm`) + fire on `activates` (default), `deactivates`, or `both`; polled at 1 Hz; `args` = `{ source, active, channel }` |
| `scriptCompleted` | another **script** finishes a run | source script (or any other script) + outcome filter (`success`, `failure`, or any); `args` = `{ script, scriptId, outcome }` |
| `timer` | every N milliseconds | interval |
| `schedule` | a cron time matches | 5-field cron (`min hour dom month dow`, `*`/`*/n`/`a-b`/`a,b`, Sun = 0 or 7) |
| `dataReceived` | a **data receiver** delivers a message (AIR-82) | receiver name (or any); payload in `args` |
| `dataClientEvent` | a client connects to / disconnects from a **TCP server** receiver (AIR-82) | receiver name (or any); `args.event` = `connected`/`disconnected` |
| `dataDelayed` | a **data route** releases a delayed message at air time (AIR-86) | receiver name (or any) + optional channel; `args` = `{ receiver, source, data, channel }` |
| `scriptDelayed` | a named one-shot scheduled by `air.After` comes due (AIR-151) | identifier (or any); `args` = `{ identifier }` |

Empty channel/event filters mean "any".

`scriptCompleted` chains are **loop-guarded**: a completion never re-triggers a
script already in the chain that led to it (`A → B → A` stops after one lap, and
a script can never trigger on its own completion — that is also rejected at save
time), and a chain stops growing after **8** hops. A suppressed hop is logged to
the live log as a warning.

`status` triggers are level-derived: the first evaluation after a (re)start or an
edit only *seeds* the level — an edge is never replayed, matching the GPO
driver's discipline (§6.2). Device-bound `gpi` triggers fire from the device's
transition indications, so LWRP reconnect dumps never re-fire them either.

Data receivers (TCP server / TCP client / UDP server) are configured under
**Data Receivers** in the console; incoming data is UTF-8 decoded and framed
per the receiver's framing setting (raw chunk or newline-split).

## Host API

Exposed as the global `air` in Lua/JavaScript (`air:Build(1)` in Lua,
`air.Build(1)` in JS); in C# the same methods are in scope directly (`Build(1)`),
except the trigger method is `Trig(...)` to avoid clashing with the `Trigger`
context variable.

**Video delay channels**
- `Build(channel)` · `Rollout(channel)` · `Dump(channel)` → bool (false if the
  command is illegal in the current state or licence-denied)
- `SetFreeze(channel, freeze)` → bool (freeze-fill is a Live-only build config)
- `Trigger(channel, templateId[, overrides])` / C# `Trig(...)` → bool (originate an
  SCTE splice from a saved trigger template). AIR-151: the optional `overrides`
  (Lua table / JS object / C# dictionary) varies the cue per call over the template —
  keys `operation` (`spliceStartNormal|spliceStartImmediate|spliceEndNormal|`
  `spliceEndImmediate|spliceCancel`), `preRollMs`, `breakDurationMs`,
  `breakDurationFrames` — the same vocabulary the REST trigger endpoint accepts:
  `air:Trigger(1, "break", { operation = "spliceStartNormal", breakDurationMs = 60000 })`
- `State(channel)` → string · `Depth(channel)` → int (frames)

**Audio (profanity) delay channels**
- `AudioBuild(channel)` · `AudioDump(channel)` · `AudioDumpAll(channel)` ·
  `AudioCough(channel)` · `AudioExit(channel)` → bool
- `AudioState(channel)` → string (`Idle`/`Building`/`InDelay`/`Exiting`)

**Encoders**
- `EncoderEnable(channel)` · `EncoderDisable(channel)` ·
  `EncoderReconfigure(channel)` → bool
- `EncoderRunning(channel)` → bool

**Alarms**
- `Alarms(channel)` → array of active alarm ids on a video channel

**Persistent variables** (shared across scripts, survive restarts)
- `GetVar(name)` → string|nil · `SetVar(name, value)` · `DeleteVar(name)`

**Diagnostics**
- `Log(level, message)` — `level` ∈ `debug|info|warn|error`; shows in the Live log.

The editor offers **autocomplete** (Ctrl-Space) for these functions and the
state/event string values in all three languages.

**One-shot scheduling (AIR-151)**
- `After(delayMs, identifier)` → bool — after the delay, the dispatcher fires a
  `scriptDelayed` trigger carrying `args.identifier`. Scheduling the same identifier
  again **replaces** the pending one-shot (latest wins) — CleanStream's
  `SetMetadataWithDelay` semantics. Fires within ~250 ms of the due time. Pending
  one-shots are volatile: they do not survive a restart.
- `CancelAfter(identifier)` → bool — cancel a pending one-shot (false if none).

## Timing (there is no `Delay`/`Sleep`)

Scripts run on a single dispatch thread with a per-invocation timeout, so there is
**no blocking `Delay`/`Sleep`** — one would stall every other script and be killed
by the timeout. For a delayed *action*, schedule a named one-shot with
**`After(delayMs, identifier)`** and handle it in a script bound to the
**`scriptDelayed`** trigger. For *recurring* work use a **`timer`** trigger (fixed
interval) or a **`schedule`** trigger (cron), and persist state across runs with
`SetVar`/`GetVar`.

A worked delay-aware ad break (data message "BREAK 1 30 60" = channel 1, break in
30 s upstream time, 60 s long; channel at depth D, pre-roll P = 4 s): the start
insert belongs at `notice + D − P` and the return at `notice + D + length − P` —
originated splices never set auto_return, so the return cue is what actually ends
the break. On `dataReceived`: parse, then `air.After(36000, "brk1-out")` and
`air.After(96000, "brk1-in")`. On `scriptDelayed`: `brk1-out` →
`air.Trigger(1, "break", { operation = "spliceStartNormal", breakDurationMs = 60000 })`,
`brk1-in` → `air.Trigger(1, "break", { operation = "spliceEndNormal" })`. A revised
break time is one more `After` with the same identifier; a cancelled break is
`CancelAfter` on both.

## Safety & limits

- Each invocation is time-bounded (1 s default). Lua/JS infinite loops are aborted
  by the engine; a runaway **C#** CPU loop is *not* interruptible (see trust model).
- **Lua/JS are sandboxed** — no CLR, filesystem, `os`/`io`/`require`, or network.
- **C# is full-trust** (Roslyn scripting can't be sandboxed in-process). Only
  admins author scripts; treat C# scripts as you would any server-side code.
- Commands are gated exactly like the console: an illegal state transition or an
  unlicensed BUILD returns `false`, it doesn't throw.

## Examples

See [`docs/examples/scripts/`](examples/scripts/): auto-dump on a GPI (Lua),
auto-SCTE on delay entry (JavaScript), a scheduled status report (C#), reacting to
inbound cues (`scte-inbound-break.js`), and the SCTE origination set (AIR-151):
`scte-break-operations.lua`/`.csx` (every splice operation via per-call overrides)
and the verified `scte-arm-break.js` + `scte-fire-break.js` pair (delay-aware
receiver-driven ad break). The console's script editor carries all of these — and
JSON/XML/binary parsing recipes — under **Examples**, in all three languages.

Verified against ENGINE-SIM: a Lua script calling `air:SetFreeze(1,true)` +
`air:Build(1)` drives channel 1 `Live → Building → Delayed`, and a JavaScript
script calling `air.Dump(1)` drives it `Delayed → Live` — each audited as
`source = script`.
