# AIR-222 — Video fill from a live external NDI source

A video delay channel's Build/INSERT fill can be a **live external NDI input**
(a station loop, a weather feed) alongside the existing conformed file assets
(AIR-13) and freeze-frame (AIR-43): while the delay buffer records, the output
airs the live fill source. The fill's own audio airs with it (the AIR-220
rule).

## Decisions

**D1 — depth model: freeze's, not the asset's.** The AIR-3 invariant (depth
after Building equals the fill length, FR-16) assumes a finite asset. A live
source has no duration, so assigning an NDI fill **forces `delayMode =
"toTime"`** — exactly the AIR-43 freeze rule — and the build window is
`targetDelaySeconds` capped at the depth ceiling. `ChannelCore` needed no
change: `TrySetFill` already validates on `TargetFrames` (the window), and
Building completes on `FillPlayer.Finished`, which is window-driven.

**D2 — delivery: a second receiver into a small fill-slot ring.** The engine
keeps its preloaded-pool-slot fill model (playback = an index walk, NFR-04).
A dedicated receiver thread (`NdiDelayEngine.FillReceiverLoop`, the
`EncodeNdiFeeder` receive shape) opens its own `recv_create_v3` on the fill
name and writes decoded frames round-robin into **8 dedicated fill pool
slots**, each frame's interval audio planar in the same slot (the `StoreFrame`
layout, so the AIR-220 fill-audio emit path works unchanged). Publishing is
one `Volatile.Write` of the newest complete slot id; `FillPlayer` in live mode
reads it per output frame (allocation- and lock-free). The writer skips the
currently-published slot, so the send loop never reads a slot mid-write; a
writer would have to lap the whole ring inside one output period (~350 fps
fill source) to collide.

**D3 — repeats air silent.** When the fill source is slower than the channel
(or stalled), the same slot re-airs. Replaying its 20 ms interval audio would
stutter, so a repeated fill frame reads as `FillPlayer.Frozen` and the emit
path airs **silence** for it, with the AIR-2 discontinuity edge fades at each
boundary. (This also implements the long-documented-but-unimplemented "silent
audio while frozen" for loop-off file fills.) Practical consequence: a fill
source at the channel's frame rate airs clean audio; a mismatched rate airs
choppy audio — match the rates.

**D4 — v1 raster constraint.** The fill source must match the channel's
locked resolution and FourCC (the receiver requests UYVY/BGRA like the main
receiver; there is no realtime scaler on this path). A mismatch raises
`ALARM_FILL_FORMAT` and the fill holds its last good frame (or the
freeze-frame preload). Frame-rate may differ (D3 covers it). Audio must be
48 kHz (`FillAudioRate`) or the fill airs silent.

**D5 — fallbacks and health.** At bind, the fill slots are preloaded with the
channel's first live frame (the AIR-43 freeze fallback), so Building before
the fill source connects airs a freeze-frame, not garbage. No fill frames for
2 s raises `ALARM_FILL_SOURCE_LOST` (self-clears on the next frame) — raised
whenever the receiver runs, so operators see it before pressing Build.

**D6 — precedence and lifecycle.** `FillNdiSourceName` lives on `ChannelDoc`
(replicates with the channel; nothing for MediaSync — there is no file). It
is mutually exclusive with `FillId`/`FreezeFill`; assigning any one clears the
others (asset assignment out of live-fill mode re-binds the engine so the
receiver stops). A matching **daypart schedule row (AIR-125) outranks the live
fill**, like the static asset assignment it stands in for. Sim channels stand
in with freeze-frame (no NDI in sim). The receiver lives and dies with the
engine bind (`Stop()` joins it before the main loop).

## Surfaces

- `POST /api/channels/{n}/fill-ndi { sourceName }` (admin, FR-23 live-only) —
  clears asset/freeze, forces toTime, audits `SET_FILL_NDI`, publishes the
  `channels` sync collection.
- `ChannelStatus.fillNdiSourceName`; SPA Fill tab gains **External NDI source
  (live)** with the source picker.
- Alarms: `ALARM_FILL_SOURCE_LOST`, `ALARM_FILL_FORMAT` (videoDelay category,
  Warning).
