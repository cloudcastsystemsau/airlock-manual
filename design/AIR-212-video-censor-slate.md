# AIR-212/213 — Video censor masking + output slate

> AIR-212 (censor video treatments, combined control), AIR-213 (technical-
> difficulties slate). Builds on AIR-131 (FrameCensor) and AIR-204 (channel lock).

Censor presses now mask the **picture** as well as bleeping the audio: blur
(block pixelate), black, or a fills-library still — configured **independently
for pre censor** (marked spans, airs when the frames reach output) **and post
censor** (output hold). A new **combined control** (`censorbothon/off`) engages
both together. Separately, an operator **slate** covers the channel output with
a still (black when none) and optionally mutes audio — after the delay and
censor stages, so **both the NDI output and the encoder branch carry it**.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Mask compositor | `VideoCensorMask` per bound format (VideoWatermark pattern): preallocated, scratch-only, in-place block-average pixelate (UYVY macropixel-aware), video black, whole-frame still copy | NFR-04: no allocations/locks on the frame path; slots replay on freeze/hold so pooled memory is never written |
| Fail policy | Unknown FourCC / missing still ⇒ **black** (unknown layout ⇒ wholesale clear) | A censor must never fail open |
| Pre vs post treatments | `FrameCensor.KindThisFrame` (post wins) picks `PreVideo`/`PostVideo` per frame | The two controls have different broadcast meaning (content vs output cover) |
| Stills | Fills-library assets; ffmpeg `-frames:v 1` conform to the locked raster at bind, volatile-swapped on config change | Reuses upload/replication (MediaSyncService) wholesale; a video asset's first frame works too |
| **Encoder tap ordering** | Emit is now: pool→scratch copy → censor mask → **slate** → `EncodeTap` reads the scratch → AIR-92 watermark blend → NDI send | The tap used to read raw pool memory (never saw censorship). It now inherits censor+slate but **not** the delay seat's watermark — encoder branding is the encode child's own seat (verified on-wire: UDP TS shows the slate + the child's ENCODE UNLICENSED burn only) |
| Tap audio | Censored/slate-muted frames pass the audio scratch (pre-wm-tone); otherwise raw pool | `Censor.Apply` **replaces** every sample, so the censored scratch is identical with or without the PGM DSP — no double-processing risk (the encode child runs its own APRM chain) |
| Combined verb | Real `FrameCensorCommand.CensorBothOn/Off` on every surface, not a UI macro | Panel/GPIO/TCP parity; AIR-204 mirrors it to audio followers as CensorOn+CensorPostOn |
| Slate semantics | Volatile flip, survives rebinds (AIR-92 pattern), **no auto-timeout**; slate wins over censor mask; `MuteAudio` default on | A slate is deliberate; it is an output cover, not content policy |
| Slate surfaces | REST `slate/{on\|off}` + `slate-config`, TCP `SLATEON/SLATEOFF <ch>`, panel `slateOn/slateOff` (catalog rebuilt for Stream Deck + Companion), Axia GPI held-only `slate` mapping (latching switch), all lock-gated + mirrored to video followers | Requested surfaces; audio channels have no slate (skipped in the mirror) |
| Telemetry | Protocol v2: 72-byte channel records, `chFlags2` at +64 (bit0 slateActive); SPA decodes v1 frames during mixed-version windows | The v1 flags byte was full |
| Sim | ENGINE-SIM slots carry no pixels — lamps/telemetry only | Masking/slate are real-NDI-engine features |

## Interlace / formats note

The pipeline is 8-bit UYVY/RGB32, sender hard-codes progressive; blur on a
(hypothetical) interlaced source would blur across fields. Documented, not
handled — nothing else in the pipeline field-splits either.

## Verified live (real NDI engine, 960x540@25 UYVY test pattern)

Post-censor blur on air (bars soften at edges, timecode/logo pixelate, tone on
meters), combined control lamps both, slate black + uploaded orange still with
muted audio and live reconform, TCP SLATEON/OFF round-trip, and an ffmpeg
capture of the encoder's UDP TS showing the slated frame with only the encode
seat's burn. Unit tests: `VideoCensorMaskTests` (9), `SlateTests` (6).
