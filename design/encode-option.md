# Airlock Encode option — design & build plan (spec §15, FR-80..87)

Licensed per-channel module adding a second output branch: H.264 MPEG-TS
over SRT beside the native NDI PGM, SCTE-35 originated from the existing
trigger engine, and R128 audio processing. The delay core is unmodified —
the encode branch consumes the air-switch output only (FR-87 by
construction).

Status: draft for review · Depends on: NDI wiring milestone (real frames on
the air-switch output), NVIDIA GPU on the deploy box.

---

## 1. Architecture — isolation first

```
Airlock.Engine (unmodified delay core)
  └─ air-switch output ──► OutputPacer ──► NDI PGM   (existing, untouched)
                              │
                              └─ EncodeTap (new): lock-free SPSC ring in
                                 shared memory — drop-oldest on backpressure,
                                 never blocks the PGM path
                                        │
                     Airlock.Encode (new, per-channel child process)
                       GStreamer pipeline:
                       appsrc ─ deinterlace(TS branch only) ─ nvh264enc ─┐
                       appsrc ─ R128 loudness + TP limiter ─ AAC/MP2 ────┤
                       SCTE-35 SIT injection (from trigger sideband) ────┼─ mpegtsmux ─ srtsink
```

Decisions:

- **D1 — Out-of-process encoder.** GStreamer + NVENC is native code with
  driver dependencies; a crash in-process would take the whole server —
  the exact failure FR-87 forbids. Each licensed channel gets an
  `Airlock.Encode` child process supervised by `Airlock.Control`
  (same pattern as the Watchdog): capped-backoff restart, `ALARM_ENCODE`
  raised, PGM untouched. Kill -9 the encoder mid-air is the acceptance
  test.
- **D2 — Tap at the air-switch output.** The tap copies the outgoing
  PGM frame (post fill/dump/rollout, i.e. exactly what NDI viewers see)
  plus PTS/scan metadata into a shared-memory SPSC ring. Engine side is
  zero-alloc and never waits: ring full → drop oldest, bump a counter.
  NFR-04 holds; the delay core has no knowledge the branch exists.
- **D3 — Triggers ride a sideband, not the frame ring.** The trigger
  engine (the one that drives SCTE-104 today) emits an encode-side event
  record `(channel, trigger frame index, event id, mode, preroll,
  segmentation params)` on a small control ring. The encoder maps frame
  index → TS PTS locally, so splice PTS = trigger frame PTS + preroll
  even under frame drops (FR-82).
- **D4 — Licence gate.** Encode is enabled per channel by a signed
  entitlement in config; unlicensed channels reject encode config at the
  REST layer and show the branch as "not licensed" in the SPA. (Signing
  scheme is a small design note of its own — same key handling as JWT
  secrets.)

## 2. Licence-clean stack (the point of §15.2)

| Component | Choice | Licence | Notes |
|---|---|---|---|
| Pipeline framework | GStreamer 1.24+ | LGPL-2.1 (dynamic link) | notices in docs/third-party.md |
| H.264 video (default) | `nvh264enc` (NVENC hardware) | plugin LGPL; NVIDIA SDK EULA | **no x264 (GPL) anywhere in the build** |
| H.264 video (software fallback) | `openh264enc` (Cisco OpenH264) | **BSD-2-Clause** | shippable in the closed module; conferencing-grade (constrained profiles, no interlaced encode, weaker RC than x264) — adequate for a monitoring/contribution feed, default-off. Deviates from §15.2 "NVENC only, no software fallback" → spec-change pack |
| H.264 video (customer-supplied) | any GStreamer element via config (D6) | customer's problem | e.g. self-installed `x264enc` — GPL combination happens at runtime on the customer's box, nothing GPL is distributed by Cloudcast |
| SRT transport | `srtsink` / libsrt | MPL-2.0 | AES-128/256 passphrase built in; caller & listener modes |
| MPEG-TS mux | `mpegtsmux` | LGPL | native SCTE-35 support, `scte-35-pid` configurable |
| SCTE-35 sections | **our own encoder** in Airlock.Engine | ours | it's an open SCTE standard — mirrors the existing SCTE-104/VANC encoders; nothing to license |
| Audio: AAC-LC (default) | `fdkaacenc` (Fraunhofer FDK) | FDK licence (attribution, no-patent-grant clause) | best-quality AAC encoder; usable under **D5** below. `avenc_aac` (LGPL) stays as the build-time fallback |
| Audio: MP2 (option) | `twolame` | LGPL | **fully patent-expired**, still ubiquitous in broadcast TS — the zero-royalty escape hatch |
| Loudness measurement | libebur128 | MIT | R128 momentary/short-term/integrated + true peak |
| Loudness control / limiter | our own gain law + −2 dBTP limiter over libebur128 readings | ours | known fixed group delay feeds the A/V realignment (FR-84) |
| HEVC | — | — | roadmap only, pending patent-pool review (per spec) |

**D5 — Codec patent exposure: accepted** (Dan Jackson, 2026-07-08).
Expected volume is ~10 units total, low-volume B2B — orders of magnitude
under the AVC pool's historical 100k-units/year royalty-free threshold,
and the AAC-LC core patent set is largely expired. On that basis fdk-aac
is promoted to the default AAC encoder (its "non-free" classification is
its patent clause, which this decision accepts; its copyright terms are
attribution-style and fine to ship). **This supersedes the §15.2 wording
"fdk-aac excluded" — add to the Cloudcast spec-change pack.** x264 remains
excluded regardless: its blocker is GPL copyright, not patents (only paths
are the commercial x264 licence or a customer-supplied encoder plugin).
Revisit this decision if sales volume or territory materially changes.

**D6 — Encoder selection is config-driven; encoding is the pluggable
part, everything else stays ours.** The pipeline is built from per-channel
config anyway (bitrate, GOP, PIDs), so the encoder element is one more
config string:

```json
"videoEncoderElement": "nvh264enc bitrate=8000 gop-size=50"      // tier 1: shipped default
"videoEncoderElement": "openh264enc bitrate=8000000"             // tier 2: BSD software fallback
"videoEncoderElement": "x264enc speed-preset=fast bitrate=8000"  // tier 3: customer-installed
```

Same for `audioEncoderElement` (fdkaacenc default per D5; avenc_aac,
twolame). At channel start Airlock instantiates the named element, encodes
a test pattern to validate caps and measure latency (feeding the FR-84
A/V realignment), and refuses with a clear config error if the element is
missing or misbehaves. The TS mux, SCTE-35 injection, SRT transport, R128
chain, counters and supervision are **never** pluggable — that keeps every
Must requirement in code we control, and the licence boundary clean: the
GPL/patent-encumbered tier-3 elements are installed by the customer and
combined only at runtime on their machine.

Deferred (no ticket until a customer needs it): a subprocess adapter for
non-GStreamer encoders — raw NV12 + PCM over pipes, Annex-B + ADTS back,
in-order output required (`bf=0`/zerolatency), fixed latency declared in a
startup handshake. Same child-process supervision shell.

**FR-81 deviation to resolve:** GStreamer has no `bwdif` element — bwdif
is FFmpeg. GPU options in GStreamer are `d3d11deinterlace` (Windows,
ID3D11VideoProcessor) and `vadeinterlace` (Linux VA-API); the portable
CPU fallback is `deinterlace` (yadif family — bwdif's parent algorithm).
The spike (E1) benchmarks `d3d11deinterlace` on the target Windows/NVIDIA
box; if quality or platform rules it out, the alternatives are CPU yadif
(cost measured in the spike) or swapping the encode child's media engine
to FFmpeg (`bwdif_cuda` exists there) — same process isolation either
way. Recommend wording FR-81 as "GPU-deinterlaced to progressive
(bwdif-class quality)" rather than naming the filter.

## 3. SCTE-35 design (FR-82/83 — the "options")

Own section encoder (`Airlock.Engine/Scte35.cs`, pure C#, unit-tested
like `Scte104`/`Vanc`), injected into `mpegtsmux` as SIT sections:

- **Both command modes**, selectable per trigger template:
  - `splice_insert` — classic avail cueing (out/in pairs, duration,
    `out_of_network_indicator`, avail num/expected).
  - `time_signal` + **segmentation descriptors** — full SCTE-35 2023
    segmentation: type IDs (provider/distributor ad start·end, program,
    break), UPID (configurable type + value), segment num/expected,
    duration.
- **PTS discipline:** splice PTS = trigger frame PTS + preroll, preroll
  configurable with a **4 s floor** enforced at config validation; 33-bit
  `pts_adjustment`/rollover handled in the encoder, tested at the
  wrap boundary.
- **Event-ID continuity:** monotonic `splice_event_id` per channel,
  persisted in LiteDB so restarts don't reuse IDs; out/in pairs share the
  ID with the `splice_event_cancel`/`out_of_network` flags set correctly.
- **Configurable transport:** SCTE PID and registration (CUEI) per
  channel; `scte-35-null-interval` (heartbeat) configurable, PMT carries
  the CUEI registration descriptor.
- **One trigger, two rails:** the same trigger event drives SCTE-104 on
  the NDI/VANC rail (existing) and SCTE-35 on the TS rail — one source of
  truth, per-rail preroll (104 keeps its ms semantics; 35 gets the 4 s
  floor).
- Emitted count and last-event details land in the counters (FR-86) and
  the audit log.

## 4. Audio path (FR-84, FR-85)

- Decode-side: the tap delivers the slot-paired PGM audio (AIR-2 model).
- Processing chain in the encode child: libebur128 measurement → slow
  loudness servo to target (−23 LUFS default, −24 selectable) → −2 dBTP
  look-ahead limiter. Total chain latency is fixed and known → video is
  delayed by exactly that amount before the mux (automatic A/V
  realignment). A/V offset is a live counter, alarmed past ±5 ms.
- **FR-85 external insert (send/return) is fenced behind the pending v1
  scope call** and planned as its own phase: AES67/Livewire RTP send +
  return (GStreamer RTP elements, PTP clocking), chirp-calibration
  latency measurement, silence watchdog with auto-bypass to the internal
  chain. Note: `Airlock.Lwrp` (AIR-24) already gives us the Livewire
  control-plane side.

## 5. Counters, alarms, UI (FR-86/87)

Per-channel encode counters on the existing dashboard/REST surface:
encode fps, ring depth + drops, NVENC queue depth, SRT RTT, SRT
retransmit/loss/bandwidth (from libsrt stats), SCTE-35 emitted,
A/V offset ms, restarts. Alarms: `ALARM_ENCODE_DOWN` (restart loop),
`ALARM_ENCODE_DROPS`, `ALARM_AV_OFFSET`. SRT config per channel: mode
(caller/listener), address/port, latency 120 ms–2 s, passphrase +
key length, stream-id.

## 6. Build plan (tickets created 2026-07-08; E8 pending scope call)

| Phase | Ticket | Scope | Exit |
|---|---|---|---|
| E1 | AIR-32 | **De-risk spike** on target hardware: GStreamer pipeline PoC (appsrc→nvh264enc→mpegtsmux(SCTE-35)→srtsink), verify shipped GStreamer's SIT time_signal support, benchmark d3d11deinterlace vs yadif, measure end-to-end latency | Go/no-go notes + pinned GStreamer version; FR-81 wording resolved |
| E2 | AIR-33 | SCTE-35 section encoder in Airlock.Engine (both modes, segmentation descriptors, event-ID continuity, PTS rollover) | Unit tests incl. golden sections checked against a reference analyser; wrap-boundary test |
| E3 | AIR-34 | EncodeTap: air-switch output tap + shared-memory frame/control rings (zero-alloc, drop-oldest) + Airlock.Encode process skeleton with supervision, restart backoff, ALARM_ENCODE | FAT: kill -9 encoder mid-air → PGM unaffected, auto-restart, alarm raised/cleared (FR-87) |
| E4 | AIR-35 | Video pipeline: config-driven encoder selection (D6: nvh264enc default, openh264enc fallback, arbitrary element for BYO) with startup validation probe + latency measurement, deinterlace policy per E1, mpegtsmux PID layout + CUEI, srtsink caller/listener + AES + latency | TS analyser-clean stream viewable in VLC over SRT both modes; all three encoder tiers exercised; missing element rejected cleanly |
| E5 | AIR-36 | Trigger→SCTE-35 wiring: sideband ring, frame-index→PTS mapping, 4 s preroll floor, LiteDB event-ID persistence, counters + audit | FAT: trigger on NDI rail and TS rail from one command; splice PTS verified against analyser |
| E6 | AIR-37 | Audio: libebur128 servo + TP limiter, A/V realignment, fdkaacenc default (D5) + avenc_aac/twolame options, loudness counters | R128 compliance on test material; A/V offset within ±5 ms sustained |
| E7 | AIR-38 | Licence gating (signed per-channel entitlement), SPA encode config/status pages, third-party notices | Unlicensed channel rejects config; licence file round-trip |
| E8 | — (not raised; pending FR-85 v1 scope call) | FR-85 external audio insert — **only if the v1 scope call says Must** | Chirp calibration + silence-watchdog bypass demo |

Sequencing notes: E1 gates everything; E2 is pure C# and can run parallel
to E1; E3 touches the engine output path (FAT cycles driver re-run
mandatory); E4–E7 stack on E3. Every engine-side change honours NFR-04.
