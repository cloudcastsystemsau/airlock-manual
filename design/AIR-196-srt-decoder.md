# AIR-196..202 — SRT receiver → NDI (VDECODE): decode + SCTE-35→104

Status: **proposed 2026-07-16** · relates to AIR-34/35 (encode pipeline), AIR-140..146
(SCTE ingest — this is its mirror), AIR-163 epic (audio decoder blocks — the
supervision/seat template), AIR-40/92 (licence enforcement, watermark), AIR-175
(XHEAAC gate precedent).

## Problem

Airlock covers every transport combination except one. It encodes NDI → SRT/TS
(H.264 + AAC, SCTE-104 → SCTE-35 on the mux), and it decodes RTP audio back to
hardware — but an *inbound* SRT transport stream has nowhere to go. A remote site
receiving an Airlock (or any) SRT contribution feed cannot turn it back into an
NDI source, and the SCTE-35 markers riding it are lost to the NDI plant, which
speaks SCTE-104 in VANC.

The ask: a **Video Decoder** block — receive SRT, decode the TS back to an NDI
video+audio source, and convert SCTE-35 sections back to SCTE-104 VANC on that
NDI output. Licence-gated by a new **VDECODE** seat count.

The investigation (2026-07-16) found most ingredients already exist, unreachable
from each other:

- SRT *input* is proven — the AIR-148 probe pulls byte-exact TS via GStreamer
  `srtsrc` (`SrtProbe.cs`); it just never decodes media.
- A first-party TS reader exists — `TsReader.cs` does sync/PID/PCR/PAT/PMT and
  PSI section reassembly (SCTE-35 `stream_type 0x86` aware). No PES extraction,
  but GStreamer's `tsdemux` supplies that.
- SCTE-35 *parsing* is mature and third-party-verified (`Scte35Decoder`, pinned
  against TSDuck in the AIR-146 FAT); SCTE-104 *encoding* exists
  (`Scte104Encoder` + `Vanc.BuildVancDataXml`, the origination path).
- Full NDI send interop exists (`NdiNative.send_*`, used by `NdiService`,
  `TestPatternService`, `ScteGen`).
- The child-process supervision, seat-licence and watermark patterns are all
  settled (AudioDecodeService / ADECODE / AIR-92).

What does **not** exist anywhere in the solution: a video decoder. All video is
raw NDI or encode-only. That, the SCTE-35→104 converter, and the glue are the
actual work.

## Model

### The child: `Airlock.Decode` (AIR-197)

One process per enabled decoder, the exact `AudioDecodeService` supervision
contract: `--config` JSON file, 1 Hz camelCase `--status` file, `--heartbeat`
shared beat block, `--parent-pid` orphan suicide, capped-backoff restarts. Like
the audio decoders, **there is no media ring** — media arrives from the network
and leaves via NDI, so the heavy bytes never cross a process boundary:

```
srtsrc → tee ┬→ tsdemux ┬→ h264parse → avdec_h264 → videoconvert(UYVY) → appsink ─┐
             │          └→ aacparse  → avdec_aac  → audioconvert       → appsink ─┼→ NDI send
             └→ appsink (raw TS 188s) → TsReader → Scte35Decoder → Scte35To104 ───┘   (in-child)
```

- The child references `Airlock.Interop` and does the NDI send itself
  (`send_send_video_v2` / `send_send_audio_v3`), pacing off the decoded PTS.
  NDI source name = configured decoder name (hostname-prefixed by the NDI
  runtime, so master and backup never collide).
- **Codecs v1: H.264 + AAC** — what Airlock's own encoder emits, which makes the
  FAT a loopback. The pipeline is explicit (no `decodebin`) for determinism;
  HEVC/MP2 are a config enum away later. First program in the PAT by default,
  optional `programNumber` override.
- SRT options mirror the encoder's set: mode caller/listener, latency,
  passphrase, pbkeylen, streamid — **plus `packetfilter`** (see FEC below).
  `srtsrc` stats (RTT, loss, retransmits) surface in the status file alongside
  resolution/fps/bitrate and SCTE section counters.

### SCTE-35 → SCTE-104 (AIR-199)

The tee's raw-TS branch feeds **our own** section machinery — `TsReader` for
PID/section reassembly and `Scte35Decoder` (CRC-checked) for parsing — not
`tsdemux`'s SCTE handling. Reasons: it is the code the AIR-146 FAT proved
against TSDuck, it decodes by `table_id` so a mislabelled PMT (the old AIR-36
defect class) still yields cues, and it keeps CRC/duplicate policy ours.

A new pure converter, `Scte35To104` (Engine, the inverse of `Scte104To35`):

- `splice_insert` (start/end/cancel, immediate or timed) → `SpliceRequest` →
  `Scte104Encoder.EncodeSpliceRequest` → `Vanc.BuildVancDataXml` → attached as
  per-frame metadata to the next outgoing NDI video frame. `splice_event_id`,
  `break_duration` (ms→tenths), `auto_return` and `unique_program_id` carry
  through unchanged.
- **Pre-roll is recomputed at emission**: `pre_roll_ms = splice PTS − PTS of the
  video frame the cue rides out on`. Computing against the *outgoing frame*
  (not arrival PCR) makes the conversion self-correcting for decode-pipeline
  latency — the mirror of AIR-145's rule that both rails must name the same
  instant. If the remaining notice is short or negative, the 104 still goes out
  at the correct instant with `ALARM_SCTE_PREROLL_SHORT` (splice-time-right
  beats notice, same philosophy as the encode side).
- **Dedupe**: TS practice repeats sections (our own encoder re-emits on the
  null-interval). One 104 per event *occurrence*: byte-identical repeats and
  same-`event_id`-same-instant repeats are dropped and counted; a
  same-event-different-instant section is a new occurrence (the AIR-146 F2
  lesson, applied in reverse).
- 33-bit PTS wrap handled with the existing `AddPts` arithmetic.
- `time_signal`/segmentation descriptors are **out of scope v1** — counted in
  the status file, not converted (`Scte104Encoder` only speaks
  `splice_request_data`; a multiple_operation_message with time_signal ops is a
  follow-up).
- Cues surface as `scteReceived`-style script triggers and audits in a later
  pass if wanted — v1 emits on the NDI output and counts; it does not enter the
  channel cue/script machinery (a decoder is not a delay channel).

### Control side (AIR-198) + UI/sync (AIR-201)

`VideoDecodeService` — a structural copy of `AudioDecodeService`: LiteDB
`videoDecoders` collection, REST CRUD + enable/disable + seat assignment,
child supervision, status aggregation, `ALARM_VDECODE_DOWN`/`_STREAM` alarms
under channel 0. SPA page mirrors the audio-decoders page.

Redundancy, per the CLAUDE.md checklist:

- `videoDecoders` **replicates** (add to `SyncCollections.ApplyOrder` +
  `SyncApplier` case; every mutating endpoint publishes
  `SyncCollections.VideoDecoders` beside its audit write).
- Decoders **run on backups** with no `SuppressExternalOutputs` hook — the
  same deliberate D7 choice as audio decoders: they only consume from the
  network, NDI names are hostname-distinct, and a warm backup feed is what
  operators want. Cost: a second SRT caller against the origin (or an idle
  listener); acceptable, documented here so nobody "fixes" it.
- Licence evaluation stays local — a backup needs VDECODE in **its own**
  licence (licenseState is hardware-bound, never synced).

### VDECODE licence gate (AIR-200)

`VDECODE=n` (bare = unlimited) — an exact `ADECODE` mirror:

- `LicenseGrant`: `VideoDecoders` count + `case "VDECODE"` in `Parse`;
  `LicensedVideoDecoders` accessor; `LicenseStatus.videoDecoders` in the DTO
  and `GET /api/license`.
- Seating: `EncodeService.EffectiveSeats` over `LicenseAssigned` decoders,
  lowest id first (`VideoDecodeService.LicensedDecoderIds()`).
- **Unseated decoders run WATERMARKED, not blocked** (the AIR-92 model): the
  child burns `VideoWatermark` into decoded frames and injects `WatermarkTone`
  bursts before the NDI send. Seat flips hot-apply via config rewrite +
  `ConfigSeq` bump, the `PushAudioProcessing` pattern.
- Issuer side: zero code — Cloudcast adds the `VDECODE=n` string in the Treek's
  licensing admin (AIR-40: "new features are new strings").
- A `LicenseTests` parse case plus the sync-classification reflection tests
  enforce the registrations.

### SRT FEC (AIR-203, independent)

libsrt's built-in XOR FEC rides its packet-filter mechanism and **works on our
pinned stack today** — verified empirically on the dev box (GStreamer 1.20.3 +
libsrt 1.4.4): `srtsink`/`srtsrc` accept `packetfilter=fec,cols:C,rows:R` as a
URI parameter, and a deliberately conflicting receiver config was rejected by
libsrt's `CheckFilterCompat` — proof the filter is negotiated, not ignored.

- Encoder: `EncodeConfig` gains `SrtPacketFilter` (validated `fec,…` string or
  cols/rows fields) appended in `SrtUri()`; encoder card UI field. Off by
  default — SRT already does ARQ; FEC is for high-RTT one-way contribution,
  and the receiver must also pass `packetfilter=fec` or the handshake carries
  no filter.
- Decoder (this epic): same option on `srtsrc`.
- **True 2022-7-style seamless dual-link (SRT socket-group bonding) is NOT
  available** on our stack — needs libsrt 1.5+ and the GStreamer SRT elements
  don't expose groups at any version. Dual-path SRT today = two independent
  encoder outputs + receiver-side failover (non-seamless). A native libsrt 1.5
  binding is the only route to seamless; parked unless a client asks.
  (The in-repo 2022-7/2022-1 code under `Airlock.Streaming/Rtp/` is RTP-layer
  and does not transplant onto SRT.)

## FAT (AIR-202)

Loopback on one box, reusing the AIR-146/147/148 tooling end to end:

```
ScteGen (NDI + SCTE-104) → delay channel → encoder (SRT out, 104→35)
      → Video Decoder (SRT in, 35→104) → NDI probe
```

The probe already measures cue frame-exactness and event-id correlation on NDI.
Pass = every cue injected by ScteGen exits the decoder's NDI output with the
same `splice_event_id`, pre-roll within tolerance of the encoder-side splice
instant, pictures/audio decoded clean at depth, plus an SRT-link-loss/reconnect
case and an unseated-watermark case. TSDuck stays the second opinion on the
intermediate TS capture.

## Decisions / edges

- **Decode-side A/V sync** is PTS-driven from the TS; the child paces NDI sends
  off decoded timestamps, not wall clock. Drift/starvation surfaces in the
  status file (`avOffsetMs`, queue depths) rather than being silently rubber-banded.
- **`srtsrc` reconnect**: wait-for-connection semantics differ from the sink;
  the child treats SRT disconnect as a stream alarm + black/silence hold, not a
  process exit (backoff restarts are for crashes, not link flaps).
- **R16 units caveat carries over**: `pre_roll_time` ms / `break_duration`
  tenths remain uncited against the purchased SCTE-104 text; the converter uses
  the same conventions as `Scte104To35` so the loopback is at least
  self-consistent, and the FAT's TSDuck cross-check keeps it honest.
- The decoder is **not a delay channel**: no FIFO, no dump/censor, no seat in
  `CHANNELS`. It is a transport block, like the audio decoders.

## Tickets

| Ticket | Scope |
|---|---|
| AIR-196 | Epic — SRT receiver → NDI (VDECODE) |
| AIR-197 | `Airlock.Decode` child: srtsrc→tsdemux→decode→NDI send |
| AIR-198 | `VideoDecodeService` + REST + `videoDecoders` collection |
| AIR-199 | `Scte35To104` + TS section tap + VANC re-insert |
| AIR-200 | VDECODE licence seats + watermark degrade |
| AIR-201 | SPA page + redundancy sync classification |
| AIR-202 | Loopback FAT (ScteGen → encode → decode → probe) |
| AIR-203 | (standalone) SRT FEC `packetfilter` option on encoder + decoder |

## Files (planned)

`src/Airlock.Decode/` (new: `Program.cs`, `DecodeConfig.cs`, `DecodePipeline.cs`,
`Gst` reuse, `DecoderStatus.cs`); `Scte35To104.cs` (Engine, new);
`TsReader`/`Scte35Decoder` (reused as-is); `VideoDecodeService.cs`,
`LicenseService.cs`, `Program.cs`, `SyncCollections.cs`, `SyncApplier.cs`
(Control); `videodecoders.tsx`, `api.ts` (SPA); `EncodeConfig.cs`/
`EncodePipeline.cs` (AIR-203). Tests: `Scte35To104Tests`, `LicenseTests`,
`DecodeConfigTests`, sync classification.
