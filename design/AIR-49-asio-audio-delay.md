# AIR-49..56 — ASIO/ALSA audio profanity delay: design

> Build tickets (created 2026-07-09, label `audio-delay`, v1 = decision D5 core):
>
> | Phase | Ticket | Scope |
> |---|---|---|
> | A1 | AIR-49 | De-risk spike: SoundTouch.Net in-callback allocation audit (gates A5/A6) |
> | A2 | AIR-50 | Delay core in Airlock.Engine (ping-pong ring, DUMP, tempo, state machine) — pure C# |
> | A3 | AIR-51 | Device contract `OnBuffer(inSpan,outSpan)` + SimDevice + AUDIO-SIM FAT |
> | A4 | AIR-52 | `Airlock.AudioDelay` child + supervision + `ChannelDoc.Kind` |
> | A5 | AIR-53 | ALSA backend (Linux, `snd_pcm_link` duplex) |
> | A6 | AIR-54 | ASIO backend (Windows, single `bufferSwitch`) |
> | A7 | AIR-55 | Control surfaces: commands, Axia GPIO, dump-WAV, monitoring taps |
> | A8 | AIR-56 | SPA audio channel card + third-party notices + spec-change pack |
>
> Sequencing: A1 ∥ A2 start together; A3←A2; A4←A2,A3; A5/A6←A1,A2,A4; A7←A4; A8←A7.
> Deferred (D5, no tickets): fill INSERT builds, dayparted fill, censor-file mode,
> build-after-dump automation, scheduled censor, Ember+/Glow, MP3 output streaming.

Status: **draft for review**. Makes Airlock a *video **and** audio* delay
server: a new standalone audio-only profanity-delay channel type alongside the
existing NDI video delay. · relates to AIR-1 (output clocking), AIR-2 (audio
model), NFR-01 (no loss/dup), NFR-04 (no alloc/lock on the hot path). · source:
Cloudcast's legacy `ProfanityDelayService` (VB.NET), reviewed and carried over
in concept, not code.

## Reference implementation (use it when stuck)

`cloudcastsystemsau/ProfanityDelayService` is a **production, field-proven**
profanity delay — old VB.NET and rough code, but the behaviour is correct and
battle-tested. **When the logic for any phase is ambiguous or a worked example
would help, read the legacy source first** and match its *behaviour* (not its
structure — we modernize the structure, honour NFR-04, and go cross-platform).
Fetch files with `gh api repos/cloudcastsystemsau/ProfanityDelayService/contents/<path> --jq .content | base64 -d` (token in `.env`).

| Airlock phase | Legacy files to read |
|---|---|
| A2 core: ping-pong + depth | `Audio/PingPongDelayBuffer.vb` (depth/`totalSamples`), `Buffers/CircularBuffer.vb` + `Buffers/DelayBuffer.vb` |
| A2 DUMP rewind | `Buffers/CircularBuffer.vb` (`AdvanceWrite`), rewind + <20 % clear-all |
| A2 tempo build/drain | `Audio/SoundTouch/SoundTouch.vb`, `SoundTouchProfile.vb`, `SoundTouchSettings.vb`, `VarispeedSampleProvider.vb` (`setTempoChange` = percent) |
| A2 state machine + modes | `Modes/{DelayState,BuildModeType,DumpModeType,ExitModeType,BuildAfterDumpType}.vb`, `DelayUnit/DelayUnit.vb` + `DelayList.vb` |
| A6 ASIO single callback | `Audio/ccAsioOut.vb`, `ccsAsio/ccsAsioOutDriver.cs`, NAudio `Wave/Asio/ASIODriverExt.cs` |
| A7 dump-to-WAV | `Audio/WaveRecorder.vb`, `Audio/Mp3Writer.vb` |
| A7 commands / GPIO | `Control/tcpControl.vb` + `tcpServer.vb`, `Axia/{Axia,Control,Status}.vb` |
| Deferred: fill / censor | `FillSchedules/Schedules.vb`, `ASSET_MANAGEMENT_AND_DELAY_FILL_ARCHITECTURE.md`, `CensorTest/` |

## Problem

Airlock delays NDI video with audio riding slot-paired inside each video frame
(AIR-2). Radio customers have **no video** — they need the classic broadcast
*profanity delay*: build a few seconds of safety delay, let the operator **DUMP**
offensive content that has entered the buffer but not yet aired, then **catch
back up** to real time, all pitch-corrected and click-free. The delay must be
**drift-free** (audio integrity is the product) and must survive a native-driver
crash without taking the server down.

The legacy service solves this on an **ASIO** duplex device with a **ping-pong
circular buffer** and **SoundTouch** time-stretch. This design brings that
concept into Airlock — modernized, cross-platform (ASIO on Windows, ALSA on
Linux), crash-isolated, and honoring the engine's zero-alloc discipline.

## Concept (source-verified from the legacy engine)

One **duplex device** provides capture and render off **one hardware clock**, so
input and output are inherently sample-locked — no drift, no resampling, no
second clock. This is the whole reason the design is single-callback:

- **ASIO (Windows):** one `bufferSwitch`/`AudioAvailable` callback hands input
  and output buffers in the same tick off the one ASIO clock
  (legacy `ASIODriverExt.BufferSwitchTimeInfoCallBack`, `ccAsioOut.vb:155`).
- **ALSA (Linux):** the capture and playback PCMs are **`snd_pcm_link`-ed** so
  they share one clock; a single period loop reads capture and writes playback
  each period — the ALSA equivalent of the callback.

Per program:

- A **circular sample ring**: the **write** pointer advances in real time
  (input); the **read** pointer advances at a **variable rate** (output). The
  gap between them **is** the delay depth.
- The read side runs through **SoundTouch tempo change** (pitch preserved,
  legacy `setTempoChange`, a **percent** delta): `TempoChange = −buildRate`
  (e.g. −7 → 0.93×, slower) **grows** the delay; `+exitRate` (+7 → 1.07×)
  **shrinks** it; `0` holds. Reported depth folds SoundTouch's internal latency
  in so the displayed figure is accurate (legacy `totalSamples`,
  `PingPongDelayBuffer.vb:297`).
- **DUMP** = **rewind the write pointer** by `dumpSize` (legacy
  `CircularBuffer.AdvanceWrite`, `CircularBuffer.vb:118`): the most-recently-
  written, not-yet-aired offensive audio is discarded and the delay instantly
  shrinks; the **read (on-air) pointer is untouched**, so program continuity is
  preserved. If a dump would leave < 20 % of the buffer, clear it all.
- **Ping-pong (A/B) + crossover:** two rings, both fed live every tick; only the
  **active** one is read to air, the inactive one is pre-filled and silent. On
  any read-pointer discontinuity — ROLLOUT/EXIT swap, delay re-target, and to
  absorb the **fixed digital latency** of the converter/ASIO round-trip — output
  **crossfades** across the ping↔pong boundary instead of hard-cutting. SoundTouch
  does the *rate* change; the crossfade does the *pointer* discontinuity.
- **States:** `Idle → Building → InDelay → Exiting → Idle`. COUGH re-arms an
  EXPAND rebuild. Dumped audio is captured to WAV for review.

## Decisions

- **D1 — Per-platform pro-audio duplex, one linked clock.** ASIO on Windows,
  ALSA (`snd_pcm_link`) on Linux; a `SimDevice` (timer-paced synthetic tone) is
  the headless/CI fallback only. All three drive the *same* engine callback
  contract `OnBuffer(inSpan, outSpan)`. Drift-free by construction — the single
  clock, not the code structure, is what guarantees it. Verified by asserting
  *samples-in == samples-out* over a long run.
- **D2 — SoundTouch.Net (managed).** Pure-C# port (LGPL-2.1, no native DLL),
  cross-platform, unit-testable on the Linux dev box — same philosophy as AIR-37
  implementing R128 natively. Rejects the native `SoundTouch_x64.dll` P/Invoke
  (Windows-only binary + a Linux `.so` to source/license).
- **D3 — Supervised child process `Airlock.AudioDelay`.** Native ASIO/ALSA
  drivers can fault; a crash must not take down `Airlock.Control`. Same isolation
  and capped-backoff supervision as `Airlock.Encode` (`ALARM_AUDIO_DOWN`,
  kill-9-mid-air is a FAT test).
- **D4 — Independent audio-only channel type.** A channel is *either* NDI-video
  (existing `NdiDelayEngine`) *or* audio (new). Audio channels are standalone
  radio delays, not synced to any video. `ChannelDoc.Kind` discriminates.
- **D5 — Core profanity delay for v1.** EXPAND build, DUMP, COMPRESS catch-up +
  ping-pong ROLLOUT exit, COUGH, dump-to-WAV. Deferred: fill-file INSERT builds,
  dayparted fill schedules, CENSOR-file mode, build-after-dump automation,
  scheduled censor commands, Ember+/Glow, MP3 output streaming.
- **D6 — NFR-04 reconciliation.** The legacy ran SoundTouch + a coarse lock
  *inside* the callback. Airlock forbids alloc/lock/blocking after start on the
  hot path. Primary: process in-callback with **all scratch pre-allocated** and
  SoundTouch **warmed** at start so its internal buffers never grow; commands via
  a lock-free queue drained at the top of each tick (the `ChannelCore.Tick`
  pattern); counters via `Volatile`/`Interlocked`. **Gated by an allocation-audit
  spike** (first ticket): if SoundTouch.Net can't be made alloc-free in-callback,
  fall back to a worker thread doing the DSP into a lock-free output ring and the
  callback only copies ring→output. Drift-free either way (single device).

  **Spike result (AIR-49, 2026-07-09) — WORKER-RING chosen.** `SoundTouch.Net`
  2.3.2 pinned (LGPL-2.1-or-later, fully managed, netstandard2.0 → runs on the
  Linux dev box). The allocation audit (`TempoStretcherAllocTests`) drives a
  warmed processor through 20 000 push/pull ticks and measures
  `GC.GetAllocatedBytesForCurrentThread`: **~3.6–3.8 bytes/tick, and two
  back-to-back windows are near-identical** (e.g. 75 888 B then 75 912 B at
  −7 %) — i.e. the allocation is *small but continuous/linear*, sourced in
  SoundTouch's internal FIFO management (`FifoSampleBuffer.EnsureCapacity`), not
  a warm-up transient, so warming cannot remove it and the interpolators/
  transposer are otherwise clean. Small as it is, a *perpetual* allocation on the
  real-time device thread eventually forces a gen-0 GC → callback pause → xrun.
  **Therefore A5/A6 use the D6 worker-ring:** `TempoStretcher` (the pinned
  wrapper, `src/Airlock.Engine/TempoStretcher.cs`) runs on a dedicated worker
  thread that fills a lock-free output ring; the ASIO/ALSA callback only copies
  ring→output — truly zero-alloc, lock-free, and the ring depth also absorbs
  SoundTouch's variable per-block CPU cost. Drift-free either way (single clock).
- **D7 — Ping-pong crossover is mandatory** (explicit requirement), used both for
  seamless EXIT/ROLLOUT swaps and to absorb the fixed digital round-trip latency
  when the read pointer is re-phased.

  **Implemented (AIR-71, 2026-07-10).** `AudioDelayCore` now holds **two**
  `RewindableFloatRing`s; both are written the live input every tick. The
  *active* ring carries the delay (read to air through the stretcher); the
  *inactive* ring is a bounded, pre-filled live window read at real time. A
  ROLLOUT exit equal-power-crossfades the active (delayed) programme to the
  inactive (live) ring across the ping↔pong boundary, then **swaps** the rings
  (the physical active ring alternates on each rollout) and jumps to live — the
  stretcher does the rate change, the crossfade does the read-pointer
  discontinuity. `AudioDelayConfig.RoundTripLatencyFrames` (default 0 for the
  single-clock core/SimDevice; set by the ALSA/ASIO backends A5/A6) offsets the
  live read via `RewindableFloatRing.PeekBehind` so the swap is phase-aligned
  with the converter round-trip. A shared `CrossfadeStep` helper is reused by
  the INSERT build crossfade. Covered by unit tests (swap alternation,
  click-free continuity, round-trip, no drift), the `PeekBehind` ring tests, and
  a ROLLOUT pass in the AUDIO-SIM FAT (`audio-cycles`, drift-free through the
  sim device).

## The model in detail

- **Internal format:** 48 kHz, float32, stereo per program. ASIO native is
  Int32LSB (convert in/out); ALSA opens S32_LE or FLOAT_LE.
- **Depth accounting:** samples ↔ ms via a fixed 48-samples-per-ms constant;
  reported depth includes SoundTouch's queued samples so the operator sees true
  on-air delay.
- **Build (EXPAND):** on `Build`, `TempoChange = −buildRate`, state → `Building`;
  each tick checks depth; when `depth ≥ delaySize`, `TempoChange = 0`, state →
  `InDelay`. `TimeToBuild = (target − current) / (stretchFactor − 1)` with
  `stretchFactor = 1 + buildRate/100`.
- **Dump:** rewind write pointer by `dumpSize` samples (clamp: if < 20 % would
  remain, clear all); clear the inactive ring + SoundTouch queue so they re-sync;
  capture the discarded span to WAV. Read pointer untouched → no on-air glitch.
- **Exit:** `Compress` — `TempoChange = +exitRate` until `depth ≈ 0` → `Idle`.
  `Rollout` — swap to the pre-filled inactive ring (crossfade), old ring drains
  fast on a separate output until empty, then `Idle`.
- **Cough:** re-arm EXPAND from the current (reduced) depth.
- **Click mitigation:** equal-power crossfade at every ping↔pong swap; reuse
  `AudioFade` (`src/Airlock.Engine/Audio.cs`) for edge-fade math and its tests.

## Configuration (`ChannelDoc.Audio`, mirrors the `Encode` sub-object)

`DeviceBackend` (asio|alsa|sim, default per-OS), `DeviceName`, in/out/rollout
channel offsets, `DelaySizeMs` (default 8000), `BuildRate` (%, default 7),
`ExitRate` (%, default 7), `DumpSizeMs` (default = DelaySizeMs), `ExitMode`
(compress|rollout), `BufferFrames`. Persisted in LiteDB, written to
`audio/ch{n}.json` for the child (mirror `encode/ch{n}.json`).

## Control surfaces (reuse Airlock's existing plumbing)

- **Commands** Build / Dump / DumpAll / Exit / Cough over the existing REST and
  TCP control (`TcpControlService`/`TcpProtocol`), and mapped to **Axia GPIO**
  via `Airlock.Lwrp` / `LwrpGpoDriver` (GPI → Dump, state → GPO tally).
- **Monitoring** input + delayed-output taps via `AudioStreamHub` +
  `OpusTapStreamer` (codec-agnostic, already built); `AudioMeter` for levels.
- **Telemetry/UI** audio counters on `TelemetryHub`; an SPA channel card with
  device pickers, delay/build/exit/dump config, BUILD/DUMP/EXIT/COUGH buttons,
  live depth-ms + state + ETA, meters + monitor speakers, alarm badge.

## Test plan

- **Unit (Linux, no hardware):** ms↔sample accounting; ping-pong write/read
  pointer math; **DUMP rewind** (write moves back, read fixed, depth −dumpSize;
  < 20 % ⇒ clear-all); crossfade energy-continuity (click-free); SoundTouch tempo
  → measured build/drain rate; state-machine transition matrix incl. COUGH.
- **AUDIO-SIM FAT** (`TestHarness -- audio-cycles 100`): synth tone through
  Build→InDelay→Dump→Exit→Idle repeatedly; assert depth hits target, dump
  discards the right span, exit drains to zero, **no xruns, no drift**
  (samples-in == samples-out).
- **Allocation audit:** steady-state callback allocates 0 bytes (the D6 spike).
- **Hardware (Windows/ASIO *and* Linux/ALSA, incl. `snd-aloop` loopback):**
  audible delay builds, DUMP removes a test word click-free, EXIT catches up;
  samples-in == samples-out over a long run; **kill -9 the child mid-air →
  Control unaffected, restart, `ALARM_AUDIO_DOWN` raised/cleared**.
- `dotnet build && dotnet test` + existing FAT cycles stay green (the
  `ChannelDoc.Kind` addition must not regress video channels).

## Spec change request (for Cloudcast) — finalised AIR-56

Add an **audio-delay channel type** to the build spec: standalone audio-only
profanity delay on a single-clock ASIO/ALSA duplex; the DUMP-by-write-pointer-
rewind semantic and the < 20 % clear-all rule; the ping-pong / equal-power
crossover; and the NFR-04 adaptation — resolved by the AIR-49 spike to the
**worker-ring** (SoundTouch runs on a worker thread feeding a lock-free ring; the
device callback only copies ring→output, proven 0 B/call).

Third-party dependencies added (in `THIRD-PARTY-NOTICES.md`):

- **SoundTouch.Net 2.3.2** — LGPL-2.1-or-later, managed pure-C# port, used as a
  separate NuGet assembly (dynamic link). A **commercial SoundTouch licence is
  held by Cloudcast** (Dan Jackson), removing the copyleft obligation; the
  dynamic-link posture keeps Airlock clean regardless.
- **NAudio 2.3.0** — MIT, ASIO duplex in the `Airlock.AudioDelay` child.

Delivery status (AIR-49..56): core, backends (ALSA/ASIO), crash-isolated child +
supervision, `ChannelDoc.Kind` + migration, and the REST/TCP command spine are
built and unit-tested (drift-free, zero-alloc device path, kill-9 restart). Pending:
hardware bring-up of ALSA/ASIO on real audio boxes; and the A7 fast-follow (Axia
GPIO tally, dump-to-WAV, Opus monitoring taps).
