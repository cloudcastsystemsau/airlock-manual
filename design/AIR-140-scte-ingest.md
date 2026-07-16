# AIR-140..146 — SCTE-104 ingest: delay, re-insert, convert

Status: **implemented 2026-07-13** (AIR-140..145; FAT/soak is AIR-146) · relates to
AIR-5 (metadata release indexing), AIR-15 (NDI vancData schema), AIR-36 (SCTE-35 on
the TS rail), AIR-86 (delayed-data trigger precedent), AIR-99..102 (GPIO parity).

## Problem

Airlock could *originate* SCTE (operator/REST/script → SCTE-104 VANC + SCTE-35 on
the TS mux) but could not *receive* it. A cue arriving from the source was freed on
the floor: `NdiDelayEngine` discarded inbound metadata on both NDI rails. The ask:
delay the cue frame-exactly with the pictures, let scripts see it, re-insert it on
the NDI output after the delay, and — when the channel also feeds SRT — convert it
to SCTE-35 so both outputs splice at the same instant.

Two discoveries reshaped the work:

1. **Most of the machinery already existed, unreachable.** `MetadataQueue` /
   `MetadataReleaser` (frame-exact, input-index keyed, AIR-5's two-step release
   rule), `FramePool`'s per-slot 4 KB metadata region + `TryWriteMetadata` (zero
   callers), `Scte104Classifier` (zero non-test callers), `ChannelDoc.SctePolicy`
   (a dead string, never read). All of it was wired only into ENGINE-SIM, where
   `ChannelManager.InjectMetadata` had no callers at all.

2. **A latent product bug (AIR-142).** `NdiDelayEngine` never drained
   `ChannelCore`'s trigger queue — the only drain is `ChannelManager.EmitFrame`,
   which runs from `SimLoop`. So on the real engine, SCTE *origination* did nothing:
   operator/REST inserts, auto-insert on build/return (FR-67..72), `air.Trigger`,
   **and the AIR-36 SCTE-35 TS rail** (whose `EncodeTriggerRecord` write lives inside
   `TriggerService.Insert`). `TriggerService` built the VANC XML, stored it in
   `LastInsertedXml`, and threw it away. Everything worked in the simulator, which is
   why it went unnoticed.

## The rejected design (worth recording)

The obvious shape — *engine copies the bytes → a control-side pump parses and
classifies → the pump injects into the delay queue* — **does not work**, and the
reasoning matters because it is the first thing anyone will propose again.

`NdiDelayEngine.Loop` is a **single thread** doing recv *and* send: a frame arriving
can air microseconds later in the same iteration. So

- at **zero depth** there is no window at all for a control round-trip, and
- a cue injected *after* a DUMP or the rollout jump satisfies `tag <= airedIndex` and
  is released **immediately, on air, stale** — verbatim the FR-64 defect that
  `AIR-5-metadata-release-indexing.md` records as found-and-fixed.

The premise behind it ("parsing allocates, so it cannot be on the engine thread") is
simply false: the NDI `vancData` payload is base64 of the 8-bit user-data words only
(no parity, no 10-bit ANC stack — `Vanc.cs`), so decoding is a span scan plus a base64
decode into a preallocated buffer. `Scte104Classifier` was already a zero-alloc span
reader. **The engine decodes inline, and nothing on the release path waits for
Control.**

## Model

- **Decoder** (`VancReader`, `Scte104Decoder`, AIR-140) — the mirror of the existing
  encoders, allocation-free (asserted by a `GC.GetAllocatedBytesForCurrentThread == 0`
  test over 100k iterations, because it runs on the frame thread). Decodes both the
  multiple_operation_message **and** the single_operation_message real gear sends: the
  old classifier called every SOM "one op, relative" without decoding it, so an
  absolute-timestamped SOM would have slipped the FR-63 drop rule. Skips unknown opIDs
  by `data_length`. Handles the edges: `did` is a *suffix* of `sdid`, foreign VANC
  packets, whitespace-wrapped base64, a sender that includes the ST 291 header,
  oversized payloads (rejected whole, never truncated — R9).

- **Two rails, re-emitted on the rail they arrived on** (AIR-141):
  - *per-frame* (`video_frame_v2_t.p_metadata`) → copied into the slot's metadata
    region at `StoreFrame`, so it rides the slot through the FIFO and is **frame-exact
    by construction at any depth, including zero**. A recycled slot **clears** the
    region, or it would re-air whatever its last tenant carried.
  - *standalone* (`frame_type_metadata`) → tagged with the input head, released by
    AIR-5's rule when that frame airs. The engine owns **its own** queue/releaser;
    `ChannelManager.InjectMetadata` stamps the SIM's counter and enqueues into the
    SIM's queue, which nothing consumes in NDI mode.
  - Only **Live/Delay** frames re-emit. A `HoldLast` frame replays the same slot every
    frame period: re-attaching would make a frozen source fire the same splice at the
    plant 50 times a second.
  - Only **SCTE VANC** is queued on the standalone rail — sources emit tally/timecode
    metadata every frame, which would overflow the ring in ~5 s at 50 fps and is not
    programme anyway.

- **Absolute-time cues** (FR-63): dropped with `ALARM_SCTE_ABSOLUTE` (a reserved
  telemetry bit that never had a raise site) — **but only once the delay has actually
  moved them**. The rule keys on the real gap between the input head and what is
  airing, not on the existence of a delay channel: at zero depth the cue still names a
  valid instant, and dropping it there would break a straight pass-through relay.

- **Policy + blocking** (`CueGate`, `SctePolicySettings`, AIR-143): per-channel rails
  (NDI re-insert, SCTE-35 convert), absolute-action, non-SCTE metadata relay, and
  per-cue-type blocking (splice-out / splice-in / time_signal). Blocking is editorial,
  not a filter — a blocked cue is still decoded, counted, audited (`SCTE_BLOCKED`) and
  still fires scripts; it just never leaves the box. Two surfaces: the persisted
  default, and a live **Block SCTE** operator toggle that is deliberately *not*
  persisted (an incident control, not configuration).
  **Orphan-break guard:** blocking returns while break starts still air would strand
  the downstream inside an ad break. The engine tracks whether a break *it aired* is
  still open and, if the matching return is blocked, airs the return anyway with
  `ALARM_SCTE_BREAK_ORPHAN`. On air, safety beats policy. (A *blocked* start opens
  nothing, so its return stays blocked — nothing is stranded.)

- **Scripts** (AIR-144): `scteReceived` (arrival) + `scteAired` (air). The gap between
  them is the delay depth and the point of the feature — a script knows an ad break is
  coming N seconds before the audience does. Read-only: scripts act *on* cues but
  cannot alter or suppress one (blocking is a policy control, not a script race on the
  frame-exact path). Both moments audited (`SCTE_RECEIVED` / `SCTE_AIRED`).

- **104 → 35 on the TS rail** (`Scte104To35`, AIR-145): as the cue goes out on NDI, an
  `EncodeTriggerRecord` goes down the encode control ring and the child builds the
  splice_insert. **The pre-roll is the upstream's own P, never the trigger template's
  4 s floor** — the re-emitted 104 carries P, so the NDI splice point is `air+P`, and
  substituting the floor would put the TS break up to 4 seconds away from the NDI
  break. If P is below the mux's conventional notice we emit at the correct splice
  point anyway and raise `ALARM_SCTE_PREROLL_SHORT`: a splice at the right time with
  short notice beats a splice at the wrong time. Control-side latency is irrelevant —
  the child extrapolates the splice PTS from the **frame index**, not from when the
  record was written. Cues arriving on both rails are deduped by
  `(splice_event_id, insert_type)` + output frame, or the TS rail double-fires.

## Test tooling (AIR-147 / AIR-148)

Nothing above is provable by unit tests alone: the claim is that a cue survives a real NDI
hop, a real delay FIFO and a real GStreamer mux. Two first-party tools close that, and both
are built around one property of the engine —

> **NDI timecode survives the delay.** `NdiDelayEngine` copies the inbound timecode into
> `SlotHeader.Timecode` and re-emits it on the delayed frame. It is not regenerated.

which makes timecode a **correlation key across the delay**, and turns "frame-exact" from an
impression into a measurement.

**`Airlock.ScteGen` (AIR-147)** is an NDI source that carries real cues. Every frame is
stamped with a timecode derived from its *frame number* (`frame * 10_000_000 / fps`), never
the wall clock, and each injected cue is written to a JSONL log with the frame and timecode
it rode. Cues go out on either metadata rail, by keypress or on a schedule. It can emit an
**absolute-time** cue, which `Scte104Encoder` cannot produce (it only ever writes `time_type`
0), so `CueBuilder` hand-splices the timestamp block into the MOM.

**`Airlock.ScteProbe` (AIR-148)** reads what came back out and checks it against that log.

- **NDI**: decodes both rails and records which *output* timecode each cue landed on. A cue
  that went in on the frame stamped T must come out on the frame stamped T; one frame of
  drift means the cue has slipped relative to the pictures it belongs to, which is the exact
  failure an eyeball on an NDI monitor cannot see. Absolute cues are asserted **absent** —
  FR-63 says drop them, so seeing one is the bug.
- **SRT/TS**: pulls with GStreamer `srtsrc` — a **byte-exact** relay — then reads the stream
  in-process (`TsReader` + `Scte35Decoder`, CRC-verified). It must not be ffmpeg:
  `ffmpeg -c copy -f mpegts` looks like a copy but *re-muxes*, rebuilding PAT/PMT and
  reassigning PIDs, which destroys the exact evidence being collected. It reports the SCTE
  **PID and stream_type as found in the PMT** — which is precisely what the open AIR-36
  defect turns on — and it asserts the **splice instant** (splice PTS minus the stream clock)
  against the upstream's pre-roll, because a section that *arrives* is not a section that
  *works*. It
  decodes sections **by `table_id`, not by PMT stream_type**, because a parser that only
  looked at streams labelled 0x86 would find nothing on a mislabelled PID and report "no
  SCTE", which is the wrong answer to the question being asked. Sections on a wrong PID is
  the *finding*. It also reports the notice each cue gave the downstream (splice PTS minus
  PCR at arrival), which is the pre-roll claim made checkable.
- **Cross-rail**: a SCTE-35 section on the TS with no matching cue on NDI (or vice versa) is
  a failure — the two outputs must name the same `splice_event_id`.

The probe exits non-zero on any failed expectation, so a soak run is a pass/fail.

**`scte-probe demo` (AIR-161)** is the same watchers rendered for a room instead of a FAT:
a live colored event feed — `▲ CUE SENT` (with `--expect` it tails the generator's log as it
grows), `● CUE AIRED` per NDI rail with frame-exactness and the measured delay, `● SCTE-35`
with a countdown ticking to the splice instant, then `✂ SPLICE OUT` / `▶ SPLICE IN` /
`▶ AUTO-RETURN` as they land. It pairs with the AIR-150 burn-in: monitors show the picture
story (countdown and splice flash going in, coming out one delay later), this console shows
the marker story. Presentation only — no verdict logic — and still honest: a CRC failure or
a duplicated section prints red, it is not filtered. Degrades to plain append-only lines when
piped. `scte-probe demo --source "Airlock CH 1" --url srt://host:9000 --expect cues.jsonl`.

### What the first end-to-end run found (2026-07-13)

Run against the real NDI engine and a real GStreamer/SRT encoder; 984 unit tests and the
100-cycle FAT driver green alongside it.

- **The ingest half is proven.** All five cue types (break start, return, immediate, cancel)
  came back out of the delayed NDI output on the *exact* frame carrying the timecode they went
  in on — zero drift at ~8 s depth — and the absolute-time cue was dropped every time. AIR-140
  through AIR-144 hold on the real engine, not just in ENGINE-SIM.
- **AIR-36 does not reproduce.** Read byte-exact off the wire, Airlock's PMT declares SCTE-35
  on **pid 500, stream_type 0x86** — correct. The "verifiable only to correct-section-bytes"
  caveat below is lifted; the rail is not blocked on AIR-32/E1.
- **The conversion half is broken — see AIR-149.** The sections are well-formed, correctly
  labelled and correctly identified, and they *splice at the wrong time*. Root cause, measured:
  `Airlock.Encode/Program.cs` sets the appsrc buffer PTS to `pushed * frameDurNs + audioLatencyNs`
  — the child's **own timeline, starting at zero** — and `ComputeSplicePts90k` extrapolates the
  splice point from that. But GStreamer's `mpegtsmux` stamps the muxed video with a **1-hour start
  offset**: every video PES PTS in the capture is exactly `324,000,000 + child buffer PTS`
  (324,000,000 ticks = 3600 s), with clean 1800-tick deltas. The splice PTS omits that offset, so
  it lands ~3600 s away from the pictures it refers to. A second, compounding fault sits in the
  same line: `pts` advances per frame *pushed*, while the extrapolation advances per *channel
  output frame*, so any encode-ring drop makes the two diverge cumulatively — which is why the
  error was unstable rather than a fixed 3600 s.
  This very likely makes the three observed symptoms **one bug**: a splice PTS on the wrong base
  falls outside the mux's schedulable window, so `mpegtsmux` silently discards the SIT (sections
  counted in `scte35Emitted` that never reach the wire; immediate splices, whose pre-roll is 0 and
  so land furthest out, producing nothing at all), and when it happens to land inside the window it
  splices at the wrong instant.

### The second opinion (TSDuck)

`Scte35Decoder` is pinned against `Scte35Encoder`, so the round-trip tests prove the two agree with
*each other* — not that either agrees with SCTE 35. A first-party decoder confirming a first-party
encoder's mistake would look exactly like a passing test. So the probe keeps a byte-exact capture
(`--save-ts`) and an independent implementation is pointed at the same bytes when a result matters:

```bash
dotnet run --project src/Airlock.ScteProbe -- both … --save-ts cap.ts
tsp -I file cap.ts -P splicemonitor --all --display-command -O drop
tsp -I file cap.ts -P tables --max-tables 4 -O drop        # PAT/PMT as a third party reads them
```

The probe's own verdict never depends on TSDuck — no external tool is needed to run a FAT — but it
is what turns "our decoder says so" into "two independent decoders say so". On 2026-07-13 TSDuck
agreed with `Scte35Decoder` field for field (event id, splice PTS, 30,000 ms duration, auto-return,
CRC OK), independently confirmed the PMT (`type 0x86, PID 500`, CUEI registration descriptor), and
independently confirmed the wrong splice instant. It also settles **R16**: 300 tenths decoded as
exactly 30,000 ms by a third party, so the tenths→ms conversion is right.

(On Ubuntu 22.04 the TSDuck build wants `libsrt.so.1.5` and jammy ships 1.4; shim it for `tsp` alone
with a symlink on `LD_LIBRARY_PATH` rather than lying to the system linker — the SRT plugin is unused
when reading a file.)

### The bench FAT (AIR-146 / T7, 2026-07-13)

Scenario FAT + bounded soak on the dev box, merged main, real NDI engine, 8 s depth,
`--rail both`, verdicts cross-checked probe ↔ TSDuck. The generator grew two FAT
commands for it: `d` (two DISTINCT cues on one video frame — cue A per-frame, cue B
standalone, same timecode) and `z` (a valid cue inflated past 4 KB with attribute
padding — R9 drop-not-truncate).

**What passed, with the receipts:**

| Case | Result |
|---|---|
| Cue queued, then DUMP before air | cue never aired on either rail, `ALARM_SCTE_IN_SKIP` at the flush ✓ |
| Cue sent *during* rollout (the AIR-7 skipped window) | never aired, `ALARM_SCTE_IN_SKIP` ✓ |
| Cue sent *before* rollout | airs during playout — correct per AIR-7 (rollout drains the buffer; only content after the command is skipped) |
| Absolute cue at 8 s depth | dropped at air, `ALARM_SCTE_ABSOLUTE` ✓ (zero-depth pass-through proven in the first e2e) |
| Oversized (4,335 B) both rails | dropped whole on both, `ALARM_METADATA_QUEUE`, nothing truncated reached either output ✓ |
| Operator block-all + cue | never aired, `scteBlockedCues` counts both rail copies, audit `SCTE_RECEIVED` still written ✓ |
| Orphan-break guard | break start aired honestly, `blockSpliceIn` set, return **forced to air** + `ALARM_SCTE_BREAK_ORPHAN`; the duplicate rail copy of the forced return was then Blocked (break already closed) — so exactly one return aired ✓ |
| Soak: 40 alternating cues @ 30 s, 21 min, 8 s depth | NDI 40/40 both rails frame-aligned (per-frame copy timecode-exact), SRT 40/40 present + spacing ≤ 20 ms, zero alarms, RSS flat (1,200→1,166 MB), `TestHarness cycles 100` PASS after ✓ |

**What it found (the point of a FAT):**

- **F1 — same-frame distinct cues: the TS rail keeps only one.** Two different cues on
  one frame both air correctly on NDI, but mpegtsmux holds ONE pending SCTE section
  (open MR 6210, all versions); two `send_event`s inside one mux window and the second
  silently overwrites the first. 5/5 reproductions lost cue A. Not fixable by upgrade;
  the child would have to space same-window sections by a mux period.
- **F2 — both-rails duplicate splice_inserts on the TS (36/40 in the soak).** The
  standalone copy's trigger record lands one output frame after the per-frame copy's
  (the releaser airs it on the next `Emit` tick), so the `(key, exact frame)` dedupe in
  `ConvertToScte35` misses and two sections go out for one event, splice instants 20 ms
  apart. TSDuck reads them as occurrence #1/#2 of the same event. At zero depth F1's
  single-slot overwrite *masks* this (the duplicate lands in the same mux window) —
  which is why the first e2e looked clean. Fix is a ±2-frame dedupe window; one line.
- **F3 — one per-frame cue vanished silently (1 of 57 both-rail cues across the runs).**
  Arrived (audited), stored, never aired, no alarm, standalone copy fine. Consistent
  with a pacer trim/NDI drop of exactly that frame — the per-frame rail has no skip
  alarm by design (only the standalone releaser alarms). Rate at depth measured
  0/40 in the soak. Mitigation stands: send on both rails; standalone is the
  guaranteed-or-alarmed rail.
- **F4 (cosmetic) — arrival accounting asymmetry for oversized cues:** the per-frame
  path counts/audits before the size gate, the standalone path gates first — so an
  oversized standalone cue is dropped+alarmed but never audited as received.
- **F5 (cosmetic) — cues arriving mid-rollout are dropped with the right alarm but no
  `SCTE_RECEIVED` audit / `scteReceived` trigger fires for them.**

The probe grew two checks out of F2/F3: frame-exactness is judged against the rail
copy that *carries* the timecode (the standalone metadata frame's transport timecode
is not preserved — the payload is verbatim; frame pairing is the releaser's job), and
the TS rail now FAILS on same-event sections with differing splice instants
(byte-identical repetition stays a conformant NOTE). Re-run against the saved soak
capture, the probe and TSDuck agree exactly: same 36 duplicated events.

## Decisions / edges

- **R16 (open, highest risk).** `pre_roll_time` (ms) and `break_duration` (tenths)
  are still uncited against the purchased SCTE-104 standard. On *encode* a wrong unit
  is a self-consistent value we control; on *decode* it translates a third party's
  values into an air-critical instant, where a 10× error moves the break by tens of
  seconds. `Scte104Decoder.IsSuspect()` flags implausible values and every decoded cue
  is audited. **Settle the citation against real automation before trusting AIR-145 on
  air.**
- **AIR-36's PID defect is unfixed** (deliberately out of scope): in-process the SCTE
  stream lands on an auto PID with stream_type 0x06 instead of `scte-35-pid=500`/0x86.
  Until the AIR-32/E1 spike lands, the 104→35 rail is verified only to "correct section
  bytes emitted", not on the wire. The 104-on-NDI half is unaffected.
- **`TriggerService.Insert` now runs on the engine thread** (as it always did on the sim
  thread) and does a LiteDB lookup + audit write. Triggers are rare and the pacer
  re-phases, but resolving them off-thread and handing the engine a ready-made record is
  the right follow-up.
- **One frame has one `p_metadata`.** If an originated cue lands on the same frame as a
  passed-through one, the originated cue takes the frame and the inbound cue airs on the
  standalone rail. Two XML documents are never merged on the frame thread.
- It remains **unverified that the downstream encoder consumes SCTE-104 from NDI VANC at
  all** (spec-review :193) — settle with an NDI-monitor capture in AIR-146.

## Files

`Scte104.cs` (+`Scte104Decoder`), `VancReader.cs`, `CueGate.cs`, `Scte104To35.cs`
(Engine); `NdiDelayEngine.cs`, `ChannelManager.cs`, `TriggerService.cs`,
`ScteCueEvent.cs`, `ScriptEngineService.cs`, `AlarmCatalog.cs`, `Models.cs`,
`SyncApplier.cs`, `Program.cs` (Control); `api.ts`, `App.tsx`, `scripts.tsx` (SPA).
Tests: `Scte104DecoderTests`, `CueGateTests`, `CuePolicyTests`, `Scte104To35Tests`,
`ScriptDispatchTests`.
