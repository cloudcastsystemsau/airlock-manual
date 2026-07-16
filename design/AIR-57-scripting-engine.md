# AIR-57 — Runtime scripting engine (Lua / JavaScript / C#)

Status: **feature-complete** (S1–S11 + AIR-73 UI polish; all PRs open, stacked).
End-to-end verified against ENGINE-SIM: a Lua script builds channel 1
(`Live → Building → Delayed`) and a JavaScript script dumps it (`Delayed → Live`),
both audited `source = script`. This is the design bible for
the scripting epic; read it before changing scripting behaviour. Ticket map at the
bottom.

## Goal

Let operators build automation **at runtime** by writing scripts in **Lua**,
**JavaScript**, or **C#** that **read status, control, and send triggers** to:

- **video delay channels** (build / rollout / dump / freeze / SCTE trigger),
- **audio (profanity) delay channels** (build / dump / dump-all / cough / exit),
- **encoders** (enable / disable / reconfigure / status).

No redeploy, no restart: edit in the browser, validate, activate.

## Reference systems (Cloudcast-Collab)

Both were studied to fix behaviour and structure; mine them when a worked example
is unclear (fetch with `gh api repos/Cloudcast-Collab/<repo>/contents/<path>`).

- **CleanStream_1** — VB.NET, **in production**, Lua-only. A dedicated `LuaEngine`
  C# assembly on **NLua / KeraLua**. Scripts are named entry functions
  (`onstart`, `onstop`, plus event/timer/schedule/GPI handlers). The host
  registers functions into the Lua state (`SetMetadata`, `GetGPI/GPO`, `Log`,
  `Email`, persistent variables, `SendUdp`, RDS…). Persistent variables live in
  LiteDB. Editor is Ace (`mode-lua` / `mode-javascript`). **This is the behaviour
  to match.**
- **AlsaWebNet** — modern .NET, the **structure** to copy. Three engine assemblies
  (`LuaEngine`, `CSharpEngine`, `JavascriptEngine`), each an `Engine` fed **one
  shared `ScriptFunctionBindings`** host-API object. Scripts carry a `language`,
  `enabled`, a trigger binding, **and versioning** (`version`, `isActive`,
  `comment` = commit message, `compiled`). A `ScriptValidationService`
  compile-checks before activation; a SignalR log hub streams live output.

## Architecture in Airlock

Airlock differs from the references — **LiteDB** (not EF), **minimal APIs** (not
MVC), a **WebSocket telemetry hub** (not SignalR), a **React SPA** (not Blazor),
and a multi-process layout. We adapt the *pattern*, not the code.

```
                      Airlock.Control (control plane)
  ┌──────────────────────────────────────────────────────────────────┐
  │  ScriptEngineService : IHostedService                              │
  │    ├─ engines: { Lua→NLua, JS→Jint, C#→Roslyn }   (IScriptEngine)  │
  │    ├─ dispatch queue (single thread, per-invocation timeout)       │
  │    └─ triggers: NotificationRaised, GPI, timer, cron, onstart/stop │
  │                          │ calls                                   │
  │                          ▼                                         │
  │  AirlockScriptApi : IScriptHost   (one instance bound per script)  │
  │    channels ─► Program.EnqueueCommand (gated: state/licence/audit) │
  │    audio    ─► AudioDelayService.SendCommand (AIR-55 IPC)          │
  │    encoders ─► EncodeService                                       │
  │    triggers ─► TriggerService                                      │
  │    log/vars ─► TelemetryHub live log / LiteDB                      │
  └──────────────────────────────────────────────────────────────────┘
```

### Non-negotiables

- **NFR-04 (zero-alloc frame path):** scripts run **only** on the control plane,
  reacting to events and issuing commands. A script **never** executes inside
  `ChannelCore.Tick` or `AudioDelayCore.Tick`. Engines, the dispatch queue and the
  host API all live in `Airlock.Control` / `Airlock.Scripting`, never in
  `Airlock.Engine`.
- **Attribution:** every state-changing host call writes an `AuditDoc` with
  `SourceInterface = "script"` and `Principal = <script name>`, reusing the same
  gated path as REST/TCP so state-legality and licence gating are identical.
- **Isolation:** a script fault (exception, infinite loop, timeout) is caught,
  logged, surfaced to the live log — and never brings down `Airlock.Control`.
- **Determinism of dispatch:** one script runs at a time on the engine service's
  own thread; the frame path and the API are decoupled by the command queue that
  already exists (`ChannelCore.Enqueue`).

### Engine choices

| Language   | Library                                   | Notes |
|------------|-------------------------------------------|-------|
| Lua        | **NLua / KeraLua** ✅ AIR-61              | Matches production CleanStream. Native `liblua` (bundled by KeraLua; verified loading on the Linux box). Host exposed as global `air:*`; entry called `entry(trigger, channel, event)`; sandbox removes os/io/load/require/package/debug (CLR never exposed); count-hook enforces the timeout. |
| JavaScript | **Jint** ✅ AIR-62                        | Pure-managed, no native dep. Host exposed as global `air.*`; entry `entry(trigger, channel, event)`; recursion bounded; a per-invocation cancellation `Constraint` (checked between statements) enforces the timeout. |
| C#         | **Roslyn** (`Microsoft.CodeAnalysis.CSharp.Scripting` 4.11, pinned to the SDK compiler) ✅ AIR-63 | Globals object `CSharpGlobals` (host API + `Trigger`/`Channel`/`Event`); whole script body runs per trigger. Compiled delegate cached at Load. **TRUST MODEL: full C#/IL, NOT sandboxable in-process — admin-authored, trusted; a CPU-bound loop is not cooperatively abortable (ct honoured only at await points).** |

## Contracts (AIR-58, `src/Airlock.Scripting`)

- `IScriptEngine` — `Language`, `Validate(source) → ScriptValidationResult`,
  `Load(source, host) → IScriptInstance`.
- `IScriptInstance` — `Invoke(entry, ScriptContext, ct) → ScriptRunResult`,
  `HasEntry(entry)`. Not thread-safe; the service serialises calls.
- `IScriptHost` — the single language-agnostic surface (log, persistent vars,
  video channel control + status, audio control + status, encoder control +
  status, SCTE triggers). One instance bound per script for audit attribution.
- Value types: `ScriptLanguage`, `ScriptTriggerKind`, `ScriptContext`,
  `ScriptRunResult`, `ScriptValidationResult`, `ScriptDiagnostic`, and the
  `*Info` status snapshots.

## Persistence (AIR-58, `Airlock.Control`)

- `ScriptDoc` (LiteDB `scripts` collection): `Id, Name, Language, Source, Enabled,
  Entry, Trigger (ScriptTriggerBinding), Version, IsActive, Comment, Compiled,
  CreatedAt, UpdatedAt`.
- `ScriptTriggerBinding`: `Kind (manual|startup|shutdown|channelEvent|gpi|timer|
  schedule), Channel?, EventName?, IntervalMs?, Cron?`.
- Registered in DI after `ChannelManager` so it stops first (reverse-order
  shutdown): a script must not command an already-stopped channel.

## Host API (AIR-59, `Airlock.Control`)

- **`ChannelCommandGate`** — the single gated path (state-legality + BUILD licence +
  audit) for Build/Rollout/Dump/Trigger. Delegate-injected (`resolveCore`,
  `canBuild`, `templateExists`, `AuditService`) so it is unit-testable against a
  bare `ChannelCore`. **REST now routes through it too** (`Program.EnqueueCommand`
  and the trigger endpoint delegate to the gate), so scripts and REST share one
  implementation — behaviour is provably identical.
- **`AirlockScriptApi : IScriptHost`** — one instance bound per script name;
  audits every mutation as `source="script"`, `principal=<name>`. Video commands
  go via the gate; audio via `AudioDelayService.SendCommand`; encoders via
  `EncodeService` (enable/disable/reconfigure mirror the REST orchestration);
  triggers via the gate; persistent vars via LiteDB.
- **`ScriptHostServices`** — the wired-once delegate bundle (built in `Program.cs`
  from the concrete services); `ScriptEngineService.CreateHost(name)` produces a
  bound `AirlockScriptApi` (the seam AIR-60 dispatch uses).
- **`ScriptVarDoc`** / `scriptVars` collection — persistent variables, shared
  across scripts (CleanStream's model), keyed by name.
- Sync-over-async note: `IScriptHost` is synchronous (Lua/JS can't await), so the
  encoder enable/disable/reconfigure delegates block on the async services via
  `GetAwaiter().GetResult()` — safe (no sync context in ASP.NET Core), and these
  run on the control-plane dispatch thread, never the frame path.

## Trigger model (AIR-60)

Bind a `ScriptDoc` to one trigger source; the engine service dispatches:

- **channelEvent** — subscribe `ChannelRuntime.NotificationRaised` (video) and the
  audio notifications; match `EventName` (e.g. `EnteredDelayed`, `Dumped`).
- **gpi** — LWRP GPI edges.
- **timer / schedule** — fixed interval / cron.
- **startup / shutdown** — `onstart` on service start (after engines exist),
  `onstop` on stop.
- **manual** — operator "Run" button / `POST /api/scripts/{id}/run`.

Generalises the existing declarative `AutoInsertConfig` hook
(`ChannelManager.cs`) — that hook remains in place and interoperates.

**Implemented (AIR-60):** `ScriptEngineService` is the dispatcher — a single
background thread draining a `BlockingCollection<Job>`, one compiled
`IScriptInstance` cached per script. Triggers wired:
- **channelEvent** — `NotificationRaised` (event name = `ChannelEvent` enum name,
  e.g. `EnteredDelayed`); optional channel + event-name filters.
- **gpi** — a new non-invasive `GpioService.InputEdgeObserved` event (rising
  edges); event-name filter = GPI index.
- **timer** — one `Timer` per script (`IntervalMs`).
- **schedule** — one minute-tick `Timer` drives all cron scripts, matched by the
  dependency-free `CronSchedule` (5-field: `* */n a-b a,b`, Sun=0/7).
- **startup / shutdown** — `onstart` enqueued at start, `onstop` drained on stop.
- **manual** — `ScriptEngineService.Invoke(id)` (the AIR-65 REST `/run` seam).

Safety: each job runs under `CancellationTokenSource(InvocationTimeoutMs=1000)`;
engines enforce it cooperatively (AIR-61/62/63). Throws and timeouts are caught
and logged — the service never dies. Trigger subscriptions are delegate-injected
(`subscribeChannelNotifications`, `subscribeGpiEdges`) so the service unit-tests
against a fake engine with no ChannelManager.

## Versioning & validation (AIR-64)

- **`ScriptService`** — CRUD + version history. Every `Save` **validates first**
  (`ScriptValidationService` → the language engine's `Validate`); an invalid source
  is refused with diagnostics and nothing changes. On success it snapshots an
  immutable **`ScriptVersionDoc`** (`scriptVersions`) and denormalises the live
  version onto the `ScriptDoc` the dispatcher reads.
- **`Activate(id, version)`** makes any stored version live (rollback when it
  precedes the current); it **re-validates before going live**, so a broken script
  can never be activated. `SetEnabled`/`Delete` round it out.
- Every mutation audits (`SCRIPT_SAVE`/`SCRIPT_ACTIVATE`/`SCRIPT_ENABLE`/
  `SCRIPT_DISABLE`/`SCRIPT_DELETE`) and calls **`ScriptEngineService.ScriptsChanged(id)`**,
  which drops the cached compiled instance (next run recompiles) and re-reads
  timer/cron bindings. Channel/GPI triggers read the DB live, so they self-refresh.
- Thread-safety: the dispatcher's instance cache + timer list are now guarded by a
  lock (worker thread vs. control-plane edits). Invalidation *removes* (not disposes)
  a cached instance so a concurrent in-flight invoke isn't yanked out from under.

## REST API + live log (AIR-65)

All under `/api/scripts`, **admin-gated**, thin wrappers over `ScriptService`:
`GET /` (list), `GET /{id}`, `GET /{id}/versions`, `POST /` (create), `PUT /{id}`
(update), `POST /{id}/activate/{version}` (rollback), `POST /{id}/enabled`,
`POST /{id}/run` (→ `ScriptEngineService.Invoke`), `POST /validate`, `DELETE /{id}`.
Save/activate return the live doc on success or `400 { error, diagnostics }` when
validation fails. `ScriptLanguage` serialises as a **string** over HTTP (targeted
`[JsonStringEnumConverter]`; LiteDB persistence unaffected).

Live log: `air:Log(...)` output and run failures are broadcast as JSON frames
(`{t, script, level, msg}`) over **`/ws/scripts/log`** (admin; JWT in the query
string) by `ScriptLogHub`, which also replays a bounded ring of recent lines to a
newly-connected console. Wired via `ScriptHostServices.Publish`.

## SPA Scripts panel (AIR-66)

- `web/Airlock.Web/src/scripts.tsx` — a new admin-only **Scripting** view (nav
  button gated on `role === 'admin'`), mirroring `lwrp.tsx`'s structure/idioms.
  Script cards (language/enabled/trigger/version pills, Edit/Run/Enable/Delete),
  an editor modal (name/language/entry/enabled + trigger-binding fields + Monaco +
  Validate + Save + version-history activate/rollback), and a live-log feed over
  `scriptLogSocketUrl()`.
- **Monaco**: `@monaco-editor/react` + `monaco-editor`, pointed at the bundled
  package (not the CDN) via `src/monaco.ts` so it works offline; only the editor
  worker + Lua/JS/C# grammars are imported (no other languages / language
  services). The panel is **lazy-loaded** (`React.lazy`) so Monaco (~2 MB) is a
  separate chunk — the main bundle stays ~305 kB and only admins opening Scripting
  pay for it.
- Verified in a headless Chromium: login → Scripting → New script mounts Monaco
  with Lua highlighting, zero console errors.
- **AIR-73** styled the section after AlsaWebNet's Blazor cards (scripting only):
  reusable `Pill` (tone-based rounded badges) + `CogMenu` (per-card gear dropdown
  for Edit/Run/Enable/Delete), clickable script cards with language + status pills,
  and a language pill on the editor header. Tailwind/dark-theme, no Bootstrap.

## Safety

- Per-invocation `CancellationToken` timeout (default a few hundred ms; runaway
  scripts are aborted).
- Lua: sandbox closes `import`. JS: Jint constraint options. C#: reference/import
  allowlist + no filesystem/process by default.
- Only a **validated** version can be activated (AIR-64).

## Ticket map

| Ticket | Scope |
|--------|-------|
| AIR-58 (S1) | contracts + `ScriptDoc` persistence + DI skeleton + this doc |
| AIR-59 (S2) | shared host API (`AirlockScriptApi`) — video, encoders, triggers |
| AIR-60 (S3) | trigger binding + scheduler + dispatch queue |
| AIR-61 (S4) | Lua engine (NLua / KeraLua) |
| AIR-62 (S5) | JavaScript engine (Jint) |
| AIR-63 (S6) | C# engine (Roslyn scripting) |
| AIR-64 (S7) | versioning + validation service + audit |
| AIR-65 (S8) | REST API + live log over WebSocket |
| AIR-66 (S9) | SPA Scripts panel (Monaco) |
| AIR-67 (S10) | audio-delay scripting (full parity; over AIR-55 IPC) |
| AIR-68 (S11) | docs (`scripting-guide.md`), examples (`docs/examples/scripts/`) + third-party notices (NLua/KeraLua/Lua MIT, Jint BSD-2, Roslyn MIT, Monaco MIT) |

## Audio-delay parity (AIR-67)

- **Control + status** were already in the host from AIR-59: `air:AudioBuild/
  AudioDump/AudioCough/AudioExit` → `AudioDelayService.SendCommand` (the AIR-55
  shared-memory command block), and `air:GetAudio`/`State` → `AudioDelayService.Status`.
- **Triggers**: audio channels run in the `Airlock.AudioDelay` child and only
  surface state via heartbeat, so `AudioDelayService` now raises a `StateChanged`
  (channel, `AudioDelayState`) event from its supervisor loop when the child's
  delay state transitions (Idle/Building/InDelay/Exiting). The dispatcher
  subscribes (delegate-injected, like the channel/GPI subscriptions) and fires
  scripts bound to the new **`audioEvent`** trigger (channel + state-name filters).
  SPA exposes it in the trigger picker.

### Note on AIR-55

`AudioDelayService.SendCommand(...)` + the shared-memory command block already
exist in the tree (tagged AIR-55) even though AIR-55 is not yet closed. AIR-67
consumes that path; if it lands ahead of AIR-67, the audio host-API methods can be
wired immediately.
