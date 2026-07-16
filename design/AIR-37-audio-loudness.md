# AIR-37 — Audio: R128 loudness, limiter, A/V realignment (Encode E6)

Status: complete + unit/live-verified. Encode design §4 (FR-84).

## Chain

Tapped PGM audio → **R128 measure → slow loudness servo → −2 dBTP look-ahead
limiter** → AAC → the same `mpegtsmux` as video, on the configured audio PID.
All the DSP is pure C# in `Airlock.Encode` (unit-testable, no native dep);
only the AAC encode + mux are GStreamer.

### Loudness measurement (`LoudnessMeter.cs`)

ITU-R BS.1770-4 / EBU R128 in C#: two-stage K-weighting IIR (high-shelf +
high-pass, bilinear-transformed for 44.1/48 kHz), per-channel mean-square with
the BS.1770 channel weights, 400 ms momentary + 3 s short-term windows, and
gated **integrated** loudness (−70 LUFS absolute then −10 LU relative gates
over 400 ms blocks at 100 ms hops). 4×-oversampled true-peak.

> The design register lists libebur128 (MIT) for this. Implemented natively so
> the whole chain is unit-tested against known signals with no extra native
> dependency; libebur128 stays a drop-in swap if a platform ever wants it. The
> gain law and limiter are ours regardless (per the design).

### Control (`LoudnessProcessor.cs`)

- **Servo**: nudges gain toward `target − measured` (default −23 LUFS; −24 for
  ATSC A/85), **slew-limited to ≤1 dB/s** so programme dynamics aren't pumped.
- **Limiter**: −2 dBTP look-ahead true-peak limiter, instant attack / ~100 ms
  release, attenuate-only. Output true peak holds the ceiling.
- Two meters: the input meter drives the servo; a second **output meter**
  reports the post-processing integrated/short-term loudness — the
  compliance-facing figure that proves the feed is at target.

### A/V realignment (FR-84)

The chain's latency is **fixed and known** (the limiter look-ahead), so the
child delays video by exactly that (adds it to every video PTS) — audio and
video stay aligned at the mux. Audio is **sample-locked to video frames**
(one frame-period of samples per frame), so at 50 fps / 48 kHz the A/V offset
is 0; when the frame rate doesn't divide the sample rate, the residual drift
is what the offset counter tracks. `EncodeService` raises `ALARM_AV_OFFSET`
when |offset| > 5 ms and clears it when it recovers.

## Encoder tiers (D5/D6)

`audioEncoderElement` is config, same pattern as video: **fdkaacenc** is the
shipped default (D5 accepted the AAC patent exposure), **avenc_aac** the LGPL
fallback, with voaacenc/twolame options. On the Linux dev box fdkaacenc isn't
compiled, so verification used avenc_aac — the config-driven selection is
exactly what makes that a non-event.

## Sim vs real audio

ENGINE-SIM rings carry no audio, so the child synthesises a −20 dBFS 1 kHz
tone paced by frames to exercise the full R128 → AAC → mux chain without NDI.
With real NDI frames the tap's planar-float PGM audio (AIR-2 slot-paired) is
deinterleaved and used instead.

## Verified

- 260/260 tests; FAT cycles 100 PASS. New DSP tests: K-weighting low-freq
  de-weighting, level linearity (+6 dB in → +6 LU), absolute-gate on silence,
  true-peak tracking, servo convergence (settled output short-term → −23 LUFS),
  slew limit, limiter holds the ceiling, fixed latency; plus audio config
  validation and launch-string branch.
- **Live** (avenc_aac, SRT listener): the TS carries **H.264 video + AAC-LC
  48 kHz stereo on the configured PID**, both decode cleanly (ffmpeg), R128
  output loudness reported and converging to target, **A/V offset 0 ms**, no
  alarms.

## Status surface

`GET /api/channels/{n}/encode` now includes `audioIntegratedLufs` (output,
compliance), `audioGainReductionDb`, and `avOffsetMs`.
