# AIR-36 — Trigger → SCTE-35 wiring (Encode E5)

Status: logic complete + unit/live-verified; **one open item deferred to the
E1 spike (AIR-32)** — see "Open" below. Encode design D3, §3.

## One trigger, two rails

A single operator trigger drives both rails from one resolved `SpliceRequest`
in `TriggerService.Insert`:

- **NDI/VANC rail** (existing): SCTE-104 → ST 2010 VANC → vancData XML.
- **TS rail** (new): an `EncodeTriggerRecord` written to the encode control
  ring; the `Airlock.Encode` child turns it into an SCTE-35 `splice_insert`
  and injects it into `mpegtsmux`.

The two rails share **one `splice_event_id`** (single source of truth) and
carry **per-rail preroll** — SCTE-104 keeps its millisecond
`PreRollMs`; SCTE-35 uses `Scte35PreRollMs` with a **4 s floor** enforced at
template save (REST 400 + unit-tested).

## Sideband record (`Airlock.Engine/EncodeTriggerRecord.cs`)

Fixed 40-byte LE record on the control ring built in AIR-34 (D3). Carries the
trigger's **output frame index** (not a wall-clock time), event id,
out-of-network / cancel / auto-return flags, TS-rail preroll, break duration,
program id, avail num/expected.

**Frame-index → PTS (FR-82):** the child anchors on its latest pushed
`(outputFrameIndex, runningTimePTS)` pair and extrapolates the splice PTS by
**frame-index delta**, so ring drops between the anchor and the trigger frame
never shift the splice point. Preroll is added and the result wrapped to
33 bits via `Scte35Encoder.AddPts`. Four unit tests pin the arithmetic,
the drop-invariance, and the wrap boundary.

## Event-id continuity

`splice_event_id` is a per-channel monotonic counter persisted in LiteDB
(`spliceSeq`), so a restart never reuses an id (unit-tested across a simulated
restart). `fixed`-strategy templates still use their fixed id.

## Counters

The child writes SCTE stats into the ring header (emitted count, last event
id, last splice PTS); `EncodeService` surfaces them on
`GET /api/channels/{n}/encode` (FR-86).

## Verified

- 248/248 tests (16 new: record round-trip, PTS mapping/drop-invariance/wrap,
  preroll-floor validation, event-id persistence across restart); FAT cycles
  100 PASS.
- **Dual rail, live**: one REST trigger produced both the SCTE-104 audit on
  the NDI rail (`SCTE_INSERTED`) and an SCTE-35 emission on the TS rail
  (`scte35Emitted=1`, ring `lastSplicePts90k` matching the frame-index→PTS
  math for a 4 s preroll).
- Template preroll floor: 1000 ms rejected, 4000 ms accepted (live).
- SCTE-35 section bytes are the AIR-33 encoder's, already validated against a
  reference analyser by that ticket's golden-vector tests.

## Open — on-wire SCTE-35 rendering (for E1 / AIR-32)

On the **Linux dev box (GStreamer 1.20.3)**, driving `mpegtsmux` **in-process**
via `gst_parse_launch` + `gst_mpegts_section_send_event`, the SCTE-35 stream
is muxed on an **auto-assigned PID with stream_type 0x06** instead of the
configured `scte-35-pid` (500, stream_type 0x86), and injected sections do not
appear as parseable SIT on the wire. The **identical launch string via the
`gst-launch-1.0` CLI on the same libraries honours `scte-35-pid=500` with
heartbeats correctly** — so this is an in-process GStreamer-runtime
integration quirk, not a logic error. Attempts made and recorded here:
parse-string property, matching the injected section PID to `scte-35-pid`,
`gst_mpegts_initialize()` before pipeline build, and explicit
`gst_util_set_object_arg` on the mux element after build — none changed the
in-process placement on this GStreamer version.

This is precisely the E1 spike's charter (AIR-32: *"verify shipped
GStreamer's SIT `time_signal` support"*) on the **pinned GStreamer version and
target hardware**. E5's wiring, PTS discipline, event-id continuity and dual-
rail origination are complete and independent of it; closing the on-wire
rendering is a runtime/version task for E1. The injection code path is in
place and exercised (`InjectScte35`), ready to validate against the pinned
build. If the pinned GStreamer still misplaces it, the fallback is a
`time_signal`+segmentation section (already supported by `Scte35Encoder`) or
requesting the SCTE mux pad explicitly.
