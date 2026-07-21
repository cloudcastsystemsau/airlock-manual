# Delayed GPIO relay (legacy pulse/static) — design for review

Status: **IMPLEMENTED 2026-07-10** — AIR-85, PR #76; verified live against
the lwwd node (GPI edge at InDelay 10.0 s → GPO pulse +10.25 s). Source: legacy ProfanityDelayService
`Axia/Control.vb` (`ControlType.pulse1..10 / static1..10`), `Axia/Status.vb`
(matching GPO status sources), `DelayUnit.setPulseGPIO / setStaticGPIO /
ClearDelayedCommand`.

## The problem

Studio GPIO that accompanies the programme (automation triggers, skimmer
start/stop, EAS relays, song markers) leaves the studio in real time, but the
programme leaves Airlock delayed. Downstream gear that acts on those contacts
must receive them **in sync with the delayed audio/video**, not the live event.

## Legacy behaviour (to match)

Ten independent **pulse** channels and ten **static** channels per delay:

- A **GPI** pin is mapped to `pulseN` or `staticN`; a **GPO** pin (any device)
  is mapped to the matching `pulseN` / `staticN` source.
- On the GPI event, the relay is armed with **interval = the delay depth at
  that moment**, then fires the GPO:
  - `pulseN` — a momentary closure, relayed once per input edge.
  - `staticN` — level-following: the GPI's new state is reproduced on the GPO
    after the delay (both edges relayed).
- Interval selection (legacy `setPulseGPIO`/`setStaticGPIO`):
  - Idle / empty buffer → **fire immediately** (passthrough).
  - Building (INSERT, no stretch) → full `DelaySize` (content entering now
    airs a full window later).
  - In delay / compress-exit → current `totalSamples` (live depth).
  - Audio with the post-censor output enabled → **+ `postCensorOffsetMs`**
    (downstream follows the post output).
- **Dump interplay** (`ClearDelayedCommand`): relays whose content was
  discarded by a DUMP never fire.

## Chosen deviations / clarifications (SCA direction)

- **Exiting ignores incoming state changes**: while a channel is Exiting
  (compress or rollout), *new* GPI relay events are ignored — not queued, not
  passed through. (Legacy dropped them on un-crossed rollout exits and was
  inconsistent elsewhere; this rule is uniform.) Already-armed relays still
  fire on schedule unless their content is dumped.
- **Building arms with the current delay time — both INSERT and EXPAND**
  (SCA, 2026-07-10): the relay interval during a build is the live depth at
  the moment of the event, uniformly. Deviates from legacy, which used the
  full `DelaySize` during INSERT builds. Known approximation: depth is still
  growing while an armed relay waits, so build-time relays fire slightly
  early relative to their content — accepted.
- Relays are **in-memory**: pending relays do not survive a Control restart
  (legacy parity). The window at risk equals the delay depth.

## Airlock design

New concept alongside the existing three GPIO features (GPI→command,
GPO←status, snake routing): a **relay** joins a GPI event to GPO(s) through a
delay channel's clock.

### Mapping surface

- `LwrpGpiMappingDoc.Command` gains `pulse1..pulse10`, `static1..static10`
  (legacy vocabulary, operator-familiar). `ChannelId` = the delay channel
  whose depth times the relay (video or audio kind).
  - `pulseN`: fires on the mapping's `ActiveOn` edge (default fallingEdge).
  - `staticN`: follows both edges; the GPO reproduces the pin state.
- `LwrpGpoDriver` source catalog gains channel-scoped `pulse1..10` /
  `static1..10`. `pulseN` uses the existing pulse machinery (`PulseMs`);
  `staticN` sets the level (active-low aware, per-mapping `ActiveLevel`).

### Relay scheduler (new, in Airlock.Control)

Per delay channel, a monotonic queue of `(dueTick, relayIndex, kind, level)`:

- Armed at GPI time with `due = now + CurrentDepthMs(channel)`:
  - video: `ChannelRuntime` depth; audio: heartbeat `DepthMs`
    (+ `PostCensorOffsetMs` when configured).
  - Idle → fire immediately (no queue entry).
  - **Exiting → drop the event** (rule above).
- A 25–50 ms sweep timer fires due relays through `LwrpGpoDriver`.
- On DUMP with `depthBefore → depthAfter`: cancel queued relays with
  `due ∈ (now + depthAfter, now + depthBefore]` — exactly the discarded span.
  Clear-all → cancel all queued relays for the channel.
- COUGH/rebuild does not disturb queued relays (their content still airs).

### Out of scope (v1)

- Persistence of pending relays across restarts.
- Non-LWRP relay inputs (scripting can already fire GPOs via the host API;
  a `relay(n)` script function could come later).
- WebSocket/Ember+ relay surfaces from legacy (`WSControl`, EmberPlus
  handlers) — Airlock's equivalents are the scripting engine + REST.

### Test plan

- Scheduler unit tests: arm at depth D → fires at D ±1 sweep; idle immediate;
  exiting dropped; dump-span cancellation (partial + clear-all); static level
  follows both edges; pulse fires once per edge.
- Integration: sim audio channel at 2 s depth, GPI edge via the resolver →
  GPO write observed ~2 s later (fake LWRP device harness, as in the AIR-24
  connection tests).
- Live check against the real lwwd node ("Dan Laptop", 24 GPI / 24 GPO).

## Review decisions

1. **Scoping**: per-channel — the mapping's ChannelId scopes its relay set;
   two channels can each use their own "pulse1" independently (proposed
   default, unobjected).
2. **`staticN` initial state**: GPOs stay at resting level after
   connect/restart until the first relayed edge (proposed default,
   unobjected).
3. **Building**: relays fire, armed with the **current delay time, for both
   INSERT and EXPAND builds** (SCA direction, 2026-07-10 — see deviation
   note above).
