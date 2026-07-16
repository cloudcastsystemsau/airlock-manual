# AIR-2 — Audio through the delay: design

Status: **DECIDED 2026-07-07 — Option A accepted** (slot-paired audio,
drift-free cadence, edge fades at discontinuities). Engine primitives
implemented and tested; NDI RecvLoop/SendLoop adoption outstanding ·
relates to spec-review R2, AIR-1 (silence-on-hold), FR-10..16, NFR-01/-04.

## Problem

Build spec v0.2 defines the delay FIFO for video slot indices only. NDI
delivers audio as *separate* frames (FLTP planar float32) whose chunk sizes
are sender-defined and generally do not align to video frame boundaries.
Unspecified: (a) how audio rides through the delay, (b) the A/V pairing rule
— especially at fractional rates (59.94/29.97, where 48 kHz is not an integer
number of samples per video frame), (c) what happens to audio at DUMP,
Building entry/exit, RollingOut→Live, and during hold. Radio-originated
customer: audio integrity is the product.

## Options

### A. Audio rides in the video slot (slot-paired A/V)  ⭐ recommended
Incoming audio chunks are re-chunked into exactly one audio buffer per video
slot, sized by a sample-accurate cadence. The existing single FIFO of slots
carries A+V together.

- ✅ A/V lock is structural: every state transition, DUMP flush, and rollout
  drain moves audio and video **atomically** — no second ring to keep
  consistent, no cut-point math at transitions.
- ✅ The pool already reserves per-slot audio regions (§3.2); the state
  machine is unchanged.
- ✅ Re-chunking copies samples — values stay **bit-exact**; only chunk
  boundaries change (NDI receivers are agnostic to chunking).
- ⚠ Needs a drift-free samples-per-frame cadence at fractional rates.
- ⚠ Original sender chunk boundaries are not preserved (they carry no
  semantic weight in NDI; timecode/timestamp are per-frame anyway).

### B. Parallel audio ring, original chunks, sample-indexed pairing
Preserves sender chunking; pairs to video by running sample count.

- ❌ Every transition needs an audio cut-point that won't align with a chunk
  boundary → either split chunks (loses the only claimed benefit) or accept
  up to ~21 ms A/V skew at every splice.
- ❌ DUMP must flush two rings consistently from two threads — a new class of
  race conditions in the most safety-critical path.
- **Rejected.**

### C. Continuous circular sample buffer, video slots hold [start,count) refs
Functionally option A with indirection; adds pointer lifetime complexity for
no additional property. **Rejected.**

## The recommended model (A) in detail

1. **Cadence** — samples per video frame via a Bresenham accumulator:
   `count(n) = floor((n+1)·S·D/N) − floor(n·S·D/N)` for sample rate S and
   frame rate N/D. Constant 960 @ 50 fps; the 800/801 (59.94) and 1601/1602
   (29.97) patterns fall out exactly, with **zero drift by construction**
   (the accumulated total is exact at every frame).
2. **Re-chunker** — an SPSC float ring per audio channel: RecvLoop bulk-writes
   incoming chunks (memcpy, no allocation); SendLoop reads exactly
   `cadence.Next()` samples into the outgoing slot region as each video frame
   is emitted. Ring capacity = a few frames; overflow/underflow are counted
   and alarmed, never silently dropped.
3. **Discontinuity marking** — the engine flags the output frames where audio
   content jumps, so the send layer can apply click mitigation:
   - Live→Building (live → fill), Building→Delayed (fill → delayed content),
     RollingOut→Live and DUMP→Live (forward jump), hold enter/exit.
   - **Delayed→RollingOut is *not* a discontinuity** — the FIFO stream is
     continuous; rollout only stops recording.
4. **Click mitigation** — 5 ms (240 samples @ 48 kHz) linear fade-out at the
   end of the outgoing content before a jump is not possible without
   lookahead, so the rule is applied on the *incoming* side of each edge:
   fade-in the first frame after every discontinuity, and synthesize the
   first hold frame as a 5 ms faded tail of the last-good audio into silence
   (AIR-1 silence-on-hold). In-place multiplies on the outgoing buffer —
   allocation-free, no added latency.
5. **Steady state stays bit-exact** — fades touch only the edge frames of a
   transition (~240 samples); pass-through audio is byte-identical samples.

## Implemented in Airlock.Engine (this change)

- `AudioCadence` — drift-free samples-per-frame generator.
- `FloatSpscRing` — lock-free bulk read/write sample ring (RecvLoop→SendLoop).
- `AudioRechunker` — per-channel chunk accumulation → exact per-frame reads.
- `AudioFade` — in-place linear fade-in/out on planar float spans.
- `SourceDecision.Discontinuity` — flagged per the matrix above (unit-tested,
  including the Delayed→RollingOut non-discontinuity).

Remaining for the NDI milestone: RecvLoop feeding rechunkers from
`audio_frame_v3_t` planes, SendLoop applying fades and emitting
`send_send_audio_v3` per output frame, underflow/overflow alarms.

## Spec change request (for Cloudcast, with AIR-1's)

Add to §3.2/§3.3: audio is slot-paired via the cadence rule above; per-frame
audio region sized for `ceil(S·D/N)+1` samples × channels. Add the
discontinuity/fade matrix to §4. State explicitly: sender audio chunk
boundaries are not preserved; sample values are bit-exact outside transition
edge fades.
