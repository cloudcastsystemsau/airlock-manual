# LWRP GPIO & Routing — Airlock integration spec

Revision of the Cloudcast "LWRP .NET Control & GPIO Automation Application"
draft, corrected against protocol verification (§2) and re-scoped to build
**inside Airlock** rather than as a standalone solution (§3). Realises build
spec §8.3 (Axia Livewire GPIO) behind the existing `IGpioPort` seam in
`src/Airlock.Control/GpioService.cs`.

Status: draft for review · Protocol baseline: Livewire Routing Protocol
v2.0.1 (Telos/Axia) · Transport: one persistent TCP socket per device,
port 93.

---

## 1. Scope

An LWRP client layer that:

1. **Device management** — add/edit/remove Axia devices (IP + port, default
   93), capability discovery via `VER`.
2. **GPIO subscription** — `ADD GPI` / `ADD GPO`, live per-pin state from
   asynchronous indications only (push-model discipline: state is never
   assumed, only trusted once an indication confirms it).
3. **Semantic mapping** — GPI pins → Airlock delay-channel **controls**
   (Build / Rollout / Dump / Trigger); GPO pins → delay-channel **status**
   (held or pulsed tallies) and the server-alarm contact.
4. **Persistence** — devices, mappings and routing rules in Airlock's
   existing LiteDB, edited from the SPA.
5. **Snake-mode routing** — deterministic source→destination audio routing
   applied on start and converged continuously (diff-only).
6. **Manual pin control** — per-pin GPO toggle; GPI simulate where the
   device supports writable GPIs.

## 2. Protocol facts (verified 2026-07 — corrections to the draft)

These corrections were verified against Axia's own IP-Driver GPIO protocol
document and two independent open-source LWRP client implementations
(anthonyeden Python clients); items marked *unverified* need a bench test or
the v2.0.1 PDF before being relied on.

- **P1 — There is no client-side `BEGIN…END` / `EXE` batch.** `BEGIN`/`END`
  are *device→client* framing around multi-line responses (e.g. the state
  dump answering `ADD GPI`). No atomic-apply mechanism exists; snake mode
  sends its `DST` lines sequentially on the connection actor (§7). Nothing
  in this design may claim or depend on atomicity.
- **P2 — `GPO n <state> DURATION:<ms>` is unverified.** Absent from every
  source checked. All pulse timing is **client-side** (§6.2); `DURATION`
  may be adopted later as a per-device capability if bench-verified.
- **P3 — Pin state strings are 5 chars, one per pin** (pin 1 = leftmost):
  `l`/`h` steady low/high, `L`/`H` a transition *to* low/high, `x` (in
  commands) leave unchanged. Uppercase also appears **in commands** as
  momentary/pulse semantics on some devices — parsers must accept it both
  ways; Airlock only ever *sends* `l`/`h`/`x`.
- **P4 — GPI writability is per-device.** Virtual GPIs on the Axia
  IP-Driver accept `GPI n <state>`; physical xNode GPIs are read-only. A
  `GpiWritable` capability flag (probed, not assumed) gates the simulate UI.
- **P5 — `CFG GPO n SRCA:"<ip>/<port>"` confirmed** (hardware GPIO
  follow-routing), `SAVE` optional after it. `FUNC:` tags unverified.
- **P6 — Axia console GPIO logic is active-low.** Default triggers and
  tally levels in this spec assume it (§5, §6).
- **P7 — `SAVE` writes device flash.** Never issued by timers or
  re-assert; only on explicit user-initiated commits, if at all. Snake
  convergence comes from re-assert, not flash persistence.
- **P8 — Writes require `LOGIN <password>` first**; 127.0.0.1 and
  password-less devices get full access; `LOGIN` with no argument reverts
  to read-only. `ERROR 1000/1004` triggers a re-`LOGIN`, capped at 3
  attempts then the device is marked `AuthFailed` (no hammering).
- **P9 — `VER` returns `LWRP`, `DEVN`, `SYSV`, `NSRC`, `NDST`, `NGPI`,
  `NGPO`** (missing tag = 0; counts may be `"8"` or `"8/1"` — parse the
  leading integer). The `ADD GPI`/`ADD GPO` dump line count cross-checks
  the declared pin-port counts. Devices with `NSRC`/`NDST` = 0 hide audio
  routing UI; `NGPI`/`NGPO` = 0 hides the GPIO grid.
- **P10 — LWRP has no keepalive.** A periodic `VER` (tied to the re-assert
  timer) doubles as a liveness probe; a missed reply window tears the
  socket down and enters reconnect.

## 3. Architecture — where this lives in Airlock

No separate service, database or UI. One new project plus integration into
the existing control plane:

| Piece | Location | Responsibility |
|---|---|---|
| `src/Airlock.Lwrp` | new project | Protocol only: line codec, `VER` tokenizer, indication parser, `PortState`, per-device **connection actor** (single writer, ordered sends, reconnect with jittered capped backoff, `VER` keepalive). No Airlock types; unit-testable against a fake TCP device. |
| `LwrpDeviceManager` | `Airlock.Control` | Hosted service owning device lifecycles: connect → `LOGIN` → `VER` → `ADD GPI`/`ADD GPO` → snake apply → steady state. Raises `(deviceId, port, PortState)` events; accepts write requests. |
| `GpioService` (existing) | `Airlock.Control` | Stays the semantic layer: mapping resolution, AIR-19 `GpioEdgeFilter` (per-channel 50 ms debounce, DUMP always passes), audit, `ChannelCommand` enqueue. Gains the mapping resolver (§5) and status writer (§6) in place of the fixed `gpi/4` scheme, which becomes the default template. |
| LiteDB collections | Airlock's existing DB | `lwrp_devices`, `lwrp_gpi_mappings`, `lwrp_gpo_mappings`, `lwrp_routing_rules` (§4). Single process, single writer — the draft's two-process shared-LiteDB design is dropped. |
| SPA pages | `web/Airlock.Web` | Device list, GPIO grid (5 pin cells per port, coloured by **confirmed** state), mapping editor, snake config, manual toggle. Live state over the existing notification/SSE path — pin state is never persisted. |

Zero-alloc NFR-04 does not apply here (nothing in `Airlock.Engine`
changes); the LWRP layer only enqueues onto the existing channel command
queue, which is already the allocation boundary.

### 3.1 Connection lifecycle (per device)

1. TCP connect; reader task consumes `<LF>`/`<CR><LF>` lines.
2. `LOGIN <password>` if configured (P8).
3. `VER` → parse/refresh capabilities (P9).
4. `ADD GPI`, `ADD GPO` → `BEGIN…END` dumps seed confirmed state *and*
   previous-state for edge detection (§5.2).
5. Apply snake routing (§7), then steady state.
6. Socket drop → jittered exponential backoff (cap 60 s), repeat from 1.
   Device is not "ready" (and its tallies show unknown in the UI) until
   step 5 completes.

## 4. Data model (LiteDB)

```csharp
public sealed class LwrpDeviceDoc
{
    public ObjectId Id { get; set; }
    public string Name { get; set; } = "";
    public string IpAddress { get; set; } = "";
    public int Port { get; set; } = 93;
    public string? Password { get; set; }      // plaintext; DB file perms are the boundary (documented)
    public bool Enabled { get; set; } = true;
    public LwrpCapabilities Caps { get; set; } = new();  // Ngpi/Ngpo/Nsrc/Ndst, Devn, Sysv, LwrpVersion, GpiWritable
}

public sealed class GpiMappingDoc
{
    public ObjectId Id { get; set; }
    public ObjectId DeviceId { get; set; }
    public int Port { get; set; }
    public int PinIndex { get; set; }          // 0-based; pin 1 = leftmost state char = index 0
    public int ChannelId { get; set; }
    public CommandKind Command { get; set; }   // Build | Rollout | Dump | Trigger
    public string? TriggerTemplateId { get; set; }   // Trigger only; default "adbreak"
    public GpiTrigger ActiveOn { get; set; } = GpiTrigger.FallingEdge;  // §5.1
    public bool Enabled { get; set; } = true;
}

public sealed class GpoMappingDoc
{
    public ObjectId Id { get; set; }
    public ObjectId DeviceId { get; set; }
    public int Port { get; set; }
    public int PinIndex { get; set; }
    public GpoStatusSource Source { get; set; }   // §6.1 catalog
    public int? ChannelId { get; set; }           // null for server-level sources
    public GpoAssertMode Mode { get; set; } = GpoAssertMode.Held;
    public PinLevel ActiveLevel { get; set; } = PinLevel.Low;    // P6
    public PinLevel RestingLevel { get; set; } = PinLevel.High;  // convergence target
    public int PulseMs { get; set; } = 100;
    public bool Enabled { get; set; } = true;
}
```

`PortState` packs levels and edges into two bytes of bitflags (no arrays —
value equality, no per-indication allocation). Malformed or short state
strings are logged, never silently defaulted.

**Pin exclusivity — GPO only.** A physical GPO pin `(DeviceId, Port,
PinIndex)` is driven by at most one enabled mapping, and no other subsystem
may write it:

1. *Storage* — composite-key uniqueness enforced at the repository layer on
   insert/update of enabled `lwrp_gpo_mappings` rows (LiteDB index on
   `$.DeviceId+'|'+$.Port+'|'+$.PinIndex`; partial-index semantics done in
   the repo since LiteDB lacks them).
2. *Runtime* — a `PinOwnershipRegistry` arbitrates all GPO writes: status
   mappings, snake `CFG GPO … SRCA` bindings and manual toggles claim
   through it. Snake apply skips (and logs) ports containing an owned pin;
   conflicts surface as configuration errors, never silently resolved.
3. *UI* — status-mapped pins render locked; manual toggle requires an
   explicit, audited operator override that suspends the mapping's writes
   until released (no racing).
4. Disabling a mapping releases its claim; re-enable re-validates.

**GPI mappings are non-exclusive.** A pin may feed any number of control
mappings, and one channel command may be wired to pins on multiple devices
(two studios, one DUMP). The editor shows existing bindings on a pin for
awareness but never blocks. Rationale: two writers on one output flap
hardware; multiple readers of one input are harmless fan-out.

## 5. GPI → channel control

### 5.1 Trigger semantics

Normal operation is **momentary active-low**: the external system pulls the
pin low to command, then releases it back high.

- Default trigger `FallingEdge` fires **only** on the `L` transition char
  in an indication. Steady `l` is previous state and never fires — not in
  later indications for the same port, and not in the `ADD GPI` dump
  (which contains steady chars only, so connect/reconnect can never
  replay commands).
- The release (`H` then steady `h`) is ignored by default; `RisingEdge`
  and level triggers remain selectable for exceptional wiring.
- **Level triggers compare against the pin's previous confirmed state**
  and fire only on that pin's own change — an indication carries all five
  pins, and without this a level mapping on pin 2 would re-fire every time
  pin 4 moved. (Edges are inherently safe: `L`/`H` mark only the changed
  pin.)
- **`Held`** (AIR-101, audio `cough`/`censor` only): level-following
  on/off pair — the pin going low sends `{command}on`, the release sends
  `{command}off` (legacy Axia semantics: cough mutes recording while the
  switch is closed and re-builds on release; censor holds a rolling
  censor span open). Like the AIR-85 static relays this bypasses the
  debounce filter — an Off must never be swallowed and leave the state
  latched.

Audio command vocabulary (AIR-69 + AIR-101/102): `build`, `dump`, `dumpall`,
`exit`, `exitcompress`, `exitrollout` (exit with the mode forced),
`cough`, `censor` (edge = the classic one-shots; held = on/off pairs),
`forcecensoroff` (edge; clears held censor state — main AND post — and every
pending span), `coughpost`, `censorpost` (AIR-102, **held-only**: silence /
tone the extra-delayed post output while the pin is low; the main air output
is untouched; requires `PostCensorOffsetMs > 0`).

### 5.2 Resolution path

`LwrpDeviceManager` raises `(deviceId, port, PortState)` → `GpioService`
resolves all enabled matching mappings (stacking allowed) → each fires
through the existing pipeline unchanged: `GpioEdgeFilter.Accept` (AIR-19:
per-channel 50 ms debounce, DUMP exempt) → audit write
(`source: "gpio"`, principal `"{device}/{port}.{pin}"`) → 
`ChannelCommand` enqueue. FR-33 command-path equivalence is preserved by
construction — GPIO lands on the same queue as REST/TCP.

**Default template** (replaces the hard-coded `gpi/4` map; applied as
editable rows when a device is added): port *n* pins 1–4 → channel *n*
Build / Rollout / Dump / Trigger("adbreak"), pin 5 spare.

## 6. GPO ← channel status

### 6.1 Status catalog

Subscribed from `ChannelManager.NotificationRaised` (the existing tally
fan-out) — never polled:

| Source | Kind | Semantics |
|---|---|---|
| `InDelay` | level | Channel state ∈ {Building, Delayed, RollingOut} — the canonical "we are delaying" tally |
| `StateBuilding` / `StateDelayed` / `StateRollingOut` / `StateLive` | level | One per `ChannelState`, for lamp-per-state panels |
| `Dumped` | event | A DUMP executed (video `ChannelEvent.Dumped`; audio dump/dumpall commands gated on a dumpable state) (audio since AIR-100) |
| `DumpedAll` | event | An audio DUMP-ALL executed (legacy `dumpalltrig`) (AIR-100) |
| `Built` | event | Delay reached target — entered Delayed / InDelay (legacy `buildtrig`-at-target) (AIR-100) |
| `WentLive` | event | Exit/rollout completed — returned to Live / Idle (legacy `rolloutendtrig`). A child (re)start reporting Idle only seeds and never fires (AIR-100) |
| `TriggerFired` | event | SCTE-104 trigger originated |
| `ServerAlarm` | level | Any active `ALARM_*` (build spec §8.3 alarm contact) |
| `DelaySafe` | level | Depth covers the dump window (±5%, legacy Axia `delaysafe`) — the "safe to dump" lamp. Audio window = `DumpSizeMs` (0 ⇒ `DelaySizeMs`); video window = the target (a video DUMP flushes everything) (AIR-99) |
| `DelayFull` / `DelayEmpty` | level | Depth ≥ 99% / ≤ 1% of target (legacy `delayfull`/`delayempty`; pulse mode gives the `*trig` variants) (AIR-99) |
| `Depth10` … `Depth100` | level | Depth ≥ N% of target — the legacy `delayNstatic` meter-bridge fuel gauge; in pulse mode fires once as each decile is crossed upward (legacy `delayN`) (AIR-99) |
| `CoughActive` / `CensorActive` | level | Audio channel: held cough in effect / censoring in effect (held open or spans queued to air) — legacy `cough` / `precensor` lamps (AIR-101) |
| `PostCoughActive` / `PostCensorActive` | level | Audio channel: post output silenced / toned by a held coughpost/censorpost — legacy `postcough` / `postcensor` lamps (AIR-102) |

Level sources may use either mode below; event sources are Pulse-only.
Since AIR-99 a level source in Pulse mode fires on its inactive→active
transition (the first evaluation after start/reconnect only seeds — state
is never replayed as a pulse).

### 6.2 Assert modes

- **Held** (default) — while the source is active the pin is held at
  `ActiveLevel` (low, per P6); on clearing, driven to `RestingLevel`
  (high). Writes are **diff-only** against the last confirmed indication;
  the device echoes every `GPO` command as an indication and only that
  echo updates confirmed state. The periodic re-assert converges the pin
  if anything external moved it.
- **Pulse** — on the source transitioning inactive→active, drive
  `ActiveLevel` for `PulseMs` (default 100 ms), then return to
  `RestingLevel`. Timing is client-side (P2): send `GPO n …l…`, timer,
  send `GPO n …h…`, each leg confirmed by its echo. A pulse encodes an
  **event, not a level**: re-assert and reconnect never re-fire one —
  recovery simply converges the pin to `RestingLevel`, even if the source
  is currently active. If the source re-activates while a pulse is in
  flight, the current pulse completes, then exactly one new pulse fires —
  never extended, never overlapped.

All writes use `x` for untouched pins, so two mappings on different pins
of one port cannot clobber each other.

## 7. Snake-mode routing (GPIO follow)

Snake mode here is **GPIO routing**: it binds a contiguous block of source
GPI ports on one node to a contiguous block of GPO ports on another, GPI
*N* → GPO *N (+ offset)*, so the destination GPOs follow the source GPIs in
hardware. It is expressed with `CFG GPO`, not `DST` — audio (`DST ADDR`)
routing is out of scope for this module (decision 2026-07-08).

```csharp
public sealed class RoutingRuleDoc
{
    public string Id { get; set; }
    public string SourceDeviceId { get; set; }      // node whose GPIs are followed
    public string DestDeviceId { get; set; }         // node whose GPOs are written
    public int SourceRangeStart { get; set; }        // first source GPI port
    public int DestRangeStart { get; set; }          // first dest GPO port
    public int Count { get; set; }
    public int Offset { get; set; }
    public string AddressMode { get; set; }          // ipPort | channel | multicast
    public bool Enabled { get; set; }
    public int ReassertIntervalSec { get; set; } = 30;
}
```

**Command.** Per destination port *i*, apply:

```
CFG GPO <destStart+i> SRCA:"<source-address>" FUNC:FOLLOW
```

sent sequentially on the destination device's connection actor (P1 — no
atomic batch exists). `FUNC:FOLLOW` is unverified (P5) and gated behind a
config flag until bench-confirmed.

**SRCA address forms** (`AddressMode`) — each names the source GPIO stream
for source port `srcStart + i + offset`; the field is polymorphic:

| Mode | SRCA value | Example | Notes |
|---|---|---|---|
| `ipPort` | `<sourceIp>/<gpiPort>` | `192.168.0.1/3` | source node IP + its GPI port; the verified Axia form |
| `channel` | `<n>` (1–32767) | `4021` | bare Livewire channel number of the source GPIO stream |
| `multicast` | `<mcast>` | `239.192.0.42` | multicast address of the source GPIO stream |

For `ipPort` the source GPI port is embedded in the address (`…/<port>`);
for `channel`/`multicast` the source-port index is added to a configured
base channel / to the multicast host octet.

**Re-assert is blind and periodic** — re-send the `CFG GPO SRCA` bindings on
the timer (`ReassertIntervalSec`) and after every reconnect, before the
device is "ready". Unlike audio `DST` (where a blind re-write restarts the
receiver and glitches on-air), re-binding a GPO to the *same* source is an
idempotent no-op on the device, so no readback/diff is needed. A
mid-sequence `ERROR` aborts the rest of that device's burst and logs; the
next tick simply re-applies. No `SAVE` (P7).

- Ranges (+offset) validate against discovered `NGPI`/`NGPO` on save and
  re-validate after every `VER`.
- Operational note: continuous re-assert will fight any other controller
  (e.g. PathFinder) binding the same GPOs — the UI warns when a rule is
  enabled.

## 8. Manual pin control

- **GPO toggle** — direct `GPO` write, subject to the ownership registry
  (§4): unowned pins toggle freely; status-owned pins require the audited
  override.
- **GPI simulate** — only on devices probed `GpiWritable` (P4); sends
  `GPI n <state>` and the UI badges the pin as *operator-simulated* until
  the next hardware indication. On read-only devices the control is
  absent, not greyed.

## 9. Command reference (implemented subset)

| Command | Purpose |
|---|---|
| `VER` | Capabilities + keepalive probe |
| `LOGIN [pwd]` | Write access (no arg = read-only) |
| `ADD GPI [list]` / `ADD GPO [list]` | Subscribe; reply is a `BEGIN…END` dump |
| `DEL GPI` / `DEL GPO` | Unsubscribe |
| `GPO n <state>` | Set output pins (`l`/`h`/`x`) |
| `GPI n <state>` | Simulate input (writable-GPI devices only) |
| `DST [n [ADDR:…]]` | Query / set receive address |
| `CFG GPO n SRCA:"ip/port"` | Hardware GPIO follow-route |
| `SAVE` | Flash persist — explicit user commits only |

Removed from the draft: `BEGIN…END`/`EXE` as client commands (P1),
`DURATION` (P2), `SRC` stream configuration (out of scope — Airlock does
not configure sources, only routes destinations).

`ERROR <n> <msg>` indications are logged per device: 1000
bad/unauthorised, 1001 syntax, 1002 bad port, 1004 invalid password;
1000/1004 → capped re-LOGIN (P8).

## 10. Build plan

Order chosen so each phase lands testable without the next, and hardware
isn't required until phase 3 (everything before it runs against a fake
LWRP device).

| Phase | Ticket | Scope | Exit test |
|---|---|---|---|
| 1 | AIR-24 | `Airlock.Lwrp` protocol core: line codec, `VER` tokenizer, indication parser (incl. `BEGIN…END` blocks, `ERROR`), `PortState` bitflags, connection actor with reconnect/backoff/keepalive, capped re-LOGIN | Unit tests against in-process fake TCP device: dump parsing, edge chars, malformed lines, reconnect storm, auth failure cap |
| 2 | AIR-25 | Device management: LiteDB collections + repositories (GPO uniqueness), `LwrpDeviceManager` hosted service, REST CRUD + status endpoints, capability discovery incl. `GpiWritable` probe | Add/enable/disable/remove devices against the fake; dump cross-check vs `VER` counts |
| 3 | AIR-26 | GPI control path: mapping resolver in `GpioService`, default template, §5 trigger semantics (prev-state tracking), wiring into `GpioEdgeFilter`/audit/command queue | FAT: fake device pulses `L` on mapped pins → BUILD/ROLLOUT/DUMP/TRIGGER land on channels; AIR-19 conflict matrix re-run over LWRP; dump-replay-on-reconnect proves no spurious fires |
| 4 | AIR-27 | GPO status path: notification subscription, Held/Pulse writer (§6.2), `PinOwnershipRegistry`, server-alarm contact, manual toggle + override | FAT: BUILD→ROLLOUT cycle drives `InDelay` held-low; dump fires one 100 ms pulse; reconnect converges without re-pulse; override audit trail |
| 5 | AIR-28 | Snake routing: rules CRUD + validation, sequential apply, diff-only re-assert (`DST` query/compare), reconnect re-apply, PathFinder-conflict warning | Fake device: full apply, drift injected → only delta rewritten, mid-sequence ERROR → abort/retry |
| 6 | AIR-29 | SPA: device list, live GPIO grid (confirmed-state colouring, edge/level badges), mapping editor (exclusivity + stacking UX), snake config, simulate/override controls | Manual pass against fake device + one real xNode/IP-Driver bench session |

Bench verification of P2 (`DURATION`) and P5 (`FUNC:` tags) happens during
the phase-3/4 hardware session; adopting either later is additive.

Per CLAUDE.md: each ticket gets its own `feat/AIR-nn-…` branch off `main`,
merged via PR; `Airlock.Lwrp` protocol changes ship with tests; phases 3–4
re-run the FAT cycles driver since they touch the command queue path.
