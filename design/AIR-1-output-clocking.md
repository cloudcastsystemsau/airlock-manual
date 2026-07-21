# AIR-1 — Output clocking design options

Status: **DECIDED 2026-07-07 — Option C accepted** (deadline scheduler as v1
default, genlock kept as a config option behind `IOutputPacer`). Implemented
in `Airlock.Engine/OutputPacer.cs`; ENGINE-SIM loop and counters wired;
`deadlineEmissions` / `rephaseEvents` in §11 counters. Spec change request to
Cloudcast still outstanding. · relates to spec-review R1, R2 (audio during
hold), R6 (timecode on repeats), FR-07, NFR-01/-04.

## Problem

Build spec v0.2 paces the SendLoop purely by input frame arrival
(`clock_video=false`, §3.1/§5). Consequences:

1. **Source loss:** no input event → no output frames at all. "Hold last-good"
   (FR-07) is unimplementable as specified. Downstream NDI receivers hold our
   last frame as a still, but playout devices may mark the source unavailable
   and trip their own failover.
2. **Delayed/RollingOut with a dead source:** the buffer stops draining — a
   ROLLOUT never completes and delayed content stops airing even though we
   hold `depth` seconds of perfectly good content. The delay buffer *should*
   mask upstream loss; input-only pacing throws that property away.
3. Any input jitter propagates directly to the output.

Whatever we choose must preserve NFR-01 (zero frame loss/dup through the
delay) and NFR-04 (no allocation/locks/blocking on the frame path).

## Constraints & facts (verified against NDI docs)

- `clock_video=true` only **rate-limits** `send_send_video_async_v2` calls
  (blocks until the next frame period). It never *generates* frames — it is a
  governor, not a clock source, so it cannot solve loss by itself.
- Receive-side `NDIlib_framesync_*` converts push→pull and does time-base
  correction by **dropping/inserting video frames and adaptively resampling
  audio**. NDI's own docs say it is *not* recommended where raw signal
  preservation matters (single-channel recording) — which is exactly Airlock's
  pass-through contract (verbatim metadata, zero loss, bit-exact audio).
- **Advanced SDK genlock** (`NDIlib_genlock_create` /
  `NDIlib_genlock_wait_video`): pace any sender to a reference NDI source;
  requires Advanced SDK licence, an NDI reference that sends continuous
  regular frames, and `clock_video=false` (which we already use).

## Options

### A. Input-paced only (spec as written)
Rejected — this is the defect. Kept as the baseline description.

### B. Free-run local clock + NDI framesync on input
Output loop runs on a local timer at the channel frame rate;
`NDIlib_framesync` pulls input frames and handles sender/receiver clock drift
by drop/insert + audio resampling.

- ✅ SDK-maintained, battle-tested TBC; audio drift handled invisibly.
- ❌ Drop/insert at the input violates NFR-01's zero-loss/dup contract
  (~±50 ppm local oscillator vs sender ⇒ a slipped frame every few minutes).
- ❌ Resampled audio is no longer bit-exact; per-frame metadata association
  across inserted/dropped frames is undefined.
- ❌ NDI's own guidance: not for raw-preservation paths.

**Verdict: rejected** for the programme path. (Fine for the preview taps if
ever needed.)

### C. Unified deadline scheduler — input-phased, free-run on loss  ⭐ recommended
One wait primitive in the SendLoop:

```
deadline = lastEmit + nominalPeriod * (1 + grace)    // grace ≈ 25%
wake     = WaitAny(inputFrameEvent, deadline)
```

- **Steady state:** the input arrival wins the wait every time → output is
  paced by input exactly as the spec intends. Zero drift, zero drop/dup,
  NFR-01 intact. The deadline is re-armed on every emission and never fires.
- **Loss (or a late frame):** the deadline fires and the SendLoop emits
  anyway, at the nominal period phase-continuing from the last real frame.
  What it emits is state-dependent (matrix below). The nominal period comes
  from the locked channel format (§5 format inheritance), not from a measured
  estimate — the source is the same format, so only phase, never rate, needs
  tracking.
- **Recovery:** the next real arrival re-phases the schedule. Minimum-spacing
  rule: if an arrival lands < 50% of a period after a deadline-driven
  emission, it is *not* emitted immediately — it becomes the next scheduled
  emission. Bounded: at most one short-ish interval, never two frames
  back-to-back, never a dropped frame.

Per-state behaviour when the deadline fires:

| State | Video | Audio | Notes |
|---|---|---|---|
| Live | repeat last-good slot | **silence**, nominal samples/frame | holdRepeats++, `ALARM_SOURCE_LOST` after 500 ms (FR-07) |
| Building | next fill frame (unchanged) | fill audio | fill playout becomes immune to input death |
| Delayed / RollingOut | **continue FIFO dequeue** | buffered audio | the delay buffer masks upstream loss for `depth` seconds; ROLLOUT always completes |

This directly answers the rollout concern: the drain is driven by the same
deadline clock, so rolling out of delay no longer depends on the source being
alive.

Supporting decisions bundled with C:

- **Audio during hold is silence, never a repeated buffer** (repeating audio
  is an audible stutter/buzz; silence is broadcast practice). Feeds R2.
- **Timecode on synthesized frames:** last timecode + nominal period per
  repeat, so downstream frame syncs keep advancing; flagged into the R6
  timecode policy table.
- **Implementation:** high-resolution waitable timer
  (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`) + the existing MMCSS Pro Audio
  SendLoop. ~0.5–1 ms wake jitter at a 20 ms frame period is absorbed by
  downstream receivers. No allocation; the timer and event are created at
  channel start (NFR-04).
- **Counters:** holdRepeats (exists), plus `deadlineEmissions` and
  `rephaseEvents` so FAT can assert the deadline never fires in steady state.

### D. `clock_video=true` (SDK governor) + free-running submission loop
The SDK paces whatever we submit; our loop free-runs and pushes
repeat/fill/FIFO frames when input is absent. Functionally converges on C but
the clock is now the SDK's local clock **always**, not just during loss →
permanent ±ppm drift against the input needs an elastic buffer with
drop/insert in steady state. Same NFR-01 violation as B, with less control.
**Verdict: rejected.**

### E. NDI genlock to a house reference (Advanced SDK)
Pace the SendLoop with `NDIlib_genlock_wait_video` locked to a plant
reference NDI source. Output timing becomes completely independent of the
input — loss, jitter, everything is absorbed by definition, and every Airlock
channel in the facility emits phase-coherent video.

- ✅ The broadcast-grade answer; also the cleanest multi-channel story.
- ❌ Requires **Advanced SDK licensing** (commercial question for Cloudcast)
  and a plant NDI reference that sends continuous regular frames.
- ❌ If the input is *not* genlocked to the same reference, input↔output ppm
  drift reappears and needs the same elastic-buffer treatment as B/D. So E
  only fully works in a genlocked plant — a deployment constraint, not a
  product default.

**Verdict: offer as a configuration option** (`clockSource: input |
genlock:<ndi-ref>`) for genlocked plants, if Advanced SDK licensing is
acceptable to Cloudcast. The SendLoop wait primitive in C abstracts cleanly
(`IOutputPacer`), so E drops in behind the same interface.

## Recommendation

**Option C as the v1 default**, with the pacer behind an `IOutputPacer`
interface so **Option E (genlock)** can be added for genlocked plants without
touching the state machine. Reject B and D on NFR-01 grounds.

Proposed spec change (for Cloudcast): replace §3.1 "paced by input frame
arrival" with the deadline-scheduler definition above, add the per-state hold
matrix, the silence-on-hold audio rule, and the timecode-increment rule; add
`deadlineEmissions` to §11 counters; add a FAT case "kill source while
Delayed → output continues from buffer, ROLLOUT completes, depth reaches 0".

## Test plan additions

1. Unit: deadline never fires with a healthy simulated source (assert
   `deadlineEmissions == 0` over 10 k frames with jitter < grace).
2. Unit: source death in each state → per-state matrix behaviour, alarm at
   500 ms, holdRepeats counts.
3. Unit: recovery re-phase — arrival 1 ms after a deadline emission is not
   emitted early; no interval < 50% period; no frame lost.
4. FAT: source-kill during RollingOut → rollout completes on schedule.
