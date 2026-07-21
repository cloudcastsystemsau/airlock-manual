# AIR-176: RTP audio transport — encoder RTP sends + Audio Decoder blocks

> Epic AIR-176; stages AIR-177..187, hardware FAT AIR-188, Standard aptX AIR-189.

## Goal

Point-to-point compressed audio between two Airlock instances (or Airlock and
any RFC-compliant third party) over RTP/UDP:

- **Send**: a new `Rtp` output family on the audio encoders (AIR-163) — Opus,
  AAC (LC/HE v1/v2), MP3 over RTP, with optional SMPTE 2022-1-style XOR FEC and
  ST 2022-7-style dual-path redundancy.
- **Receive**: a new **Audio Decoder** block — UDP listen (1–2 legs), 2022-7
  merge, FEC recovery, jitter buffer, decode, gain/EQ/comp, playout to a
  baseband soundcard (ASIO / ALSA / Sim).

Explicit non-goals (settled at review): full ST 2110-30 (linear-PCM-only, PTP,
SDP/NMOS — incompatible with compressed codecs and out of scope), RTCP (both
ends are configured explicitly; stats ride Airlock's own status surfaces).

> **aptX update (AIR-189):** the two original aptX blockers turned out to be
> false — RFC 7310 *is* a standards-track RTP payload for aptX, and Standard
> aptX's core patents (EP0398973/EP0400755) expired in 2009. **Standard aptX**
> is now implemented (Phase 1, see D6). **Enhanced/HD/Adaptive aptX** remain out
> of scope: those rest on live patents and need a paid Qualcomm SDK licence — a
> gated Phase 2, forward-compatible via RFC 7310's `variant=enhanced` signalling.

## D1 — Wire format

RTP per RFC 3550: V=2, no CSRC/extension/padding on send (all tolerated on
receive). SSRC random per pipeline start; sequence/timestamp start random. All
sequence comparisons use serial arithmetic (`RtpSeq`).

| Codec | Payload RFC | Default PT | TS clock | Packetization |
|---|---|---|---|---|
| Opus | RFC 7587 | 96 | always 48 kHz | 1 Opus frame/packet; ptime 10/20/40/60 ms (default 20); CBR; optional in-band FEC (LBRR) |
| AAC | RFC 3640 `mpeg4-generic` AAC-hbr | 97 | native sample rate | AU-headers-length + 16-bit AU header (sizeLength=13, indexLength=3, indexDeltaLength=3); one AU per packet, §3.2 fragmentation when over budget (M=1 on final fragment) |
| MP3 | RFC 2250 | 14 (static MPA) | 90 kHz | 4-byte MPEG audio header + one complete MPEG-1 L3 frame |
| aptX (Standard) | RFC 7310 | 98 | native sample rate | no framing — packed aptX bytes, one ptime/packet; stereo-only, fixed 4:1; ptime 2–20 ms (RFC default 4), rounded to whole 4-sample blocks |

Why RFC 3640 over LATM (RFC 6416): it is what ffmpeg/GStreamer/broadcast STL
codecs speak, and explicit AU-size headers make reassembly deterministic. The
usual LATM argument (in-band mux config without SDP) is moot — the decoder
builds the AudioSpecificConfig deterministically from its own configured
profile/rate/channels and feeds `aacDecoder_ConfigRaw`.

Why RFC 2250 over RFC 5219 (ADU): loss robustness is provided uniformly by the
FEC/2022-7 layers below the codec, and PT 14 keeps streams debuggable with
VLC/ffmpeg.

Payload budget = `Mtu` (default 1400) − 12; config validation rejects settings
that cannot fit.

## D2 — SMPTE 2022-1 XOR FEC

2022-1 profile of RFC 2733. Media on port **P**, column FEC on **P+2**, row FEC
on **P+4** (the 2022 convention; hence `port ≤ 65531` when FEC is on). FEC
streams are independent RTP streams: own sequence numbers, **SSRC=0**
(receivers associate by port), PT 96.

FEC header (16 bytes after the RTP header): `SNBase(16) | LengthRecovery(16) |
E=1|PTRecovery(7) | Mask(24)=0 | TSRecovery(32) | X=0|D|Type=0|Index=0 |
Offset(8) | NA(8) | SNBaseExt(8)=0`. Column packets D=0, Offset=L, NA=D —
protect `SNBase, +L, …, +L·(D−1)`; row packets D=1, Offset=1, NA=L — protect
`SNBase … +L−1`. Recovery XORs payload (padded via LengthRecovery), PT and TS
per RFC 2733 §4.

Modes `none | column | columnRow`; L ∈ 1..20, D ∈ 4..20, L·D ≤ 100; default
5×5. Column-only recovers any single loss per column (and a burst up to L when
losses land in distinct columns); adding rows enables iterative row↔column
recovery (looped until a pass makes no progress). Latency floor: the receive
jitter target is raised to the matrix span (L·D·ptime) + margin, learned from
the first parity header (the sender's L/D are not configured receive-side).

Measured, loopback with 20 % independent loss per 2022-7 leg (Opus 96 kbps,
5×4 column FEC, LBRR on): 1360 packets → 429 delivered by only one leg, 87
double-losses rebuilt by FEC, all 14 residual losses reconstructed from LBRR —
one concealed frame in 27 s.

## D3 — ST 2022-7 dual path

Leg identity is structural, not procedural: one `RtpPackager` builds every
datagram exactly once; `RtpSender` transmits the same buffer on both legs
(each leg optionally bound to a different local NIC address). The receiver
inserts both legs into one `JitterBuffer`; the seq-keyed duplicate drop *is*
the merge (first arrival wins, gaps fill from either leg). A healthy pair
shows `duplicates ≈ received/2`; a one-leg outage shows as the path alarm,
not as audio loss.

### Multicast (AIR-190)

Multicast is a transport property below the codec, so it works for **every**
codec with no codec change: a group address (224.0.0.0/4) in the send
destination or the decoder listen field switches that stream to multicast.
`RtpSender` sets `IP_MULTICAST_TTL` (from the leg TTL) and, when a local NIC is
given, pins egress with `IP_MULTICAST_IF`; `RtpReceiver` binds `ANY:port` with
`SO_REUSEADDR` and `JoinMulticastGroup`, on a specific NIC when the decoder's
`MulticastInterface` is set (dual-NIC 2022-7 → the primary group joins on the
named NIC, the secondary on the default). The 2022-1 FEC ports (+2/+4) join the
same group as their media leg. `RtpReceiver.IsMulticastAddress` gates config
validation. Live multicast needs an IGMP-capable plant network — validated at
the AIR-188 FAT, not on the cloud dev box (no 224/4 route there).

## D4 — Decoder is a supervised child (`Airlock.AudioDecode`)

Same rationale as AIR-49 D3: native codec (libfdk) + soundcard drivers are the
crash surfaces, so they live in a per-block child with the established
supervision contract (capped-backoff restarts, exit 3 = config error no
restart, status file at 1 Hz, orphan guard on parent PID). Liveness = status
file freshness (the encode child's ring-heartbeat analogue — there is no shm
ring here; the audio arrives by network).

Thread model (NFR-04 on the device callback):

```
socket threads (media ×2, fec ×2..4)      blocking UdpClient, pooled buffers
        → bounded Channel<datagram>       drop-oldest + counter
reassembly worker                          RTP parse → PT/SSRC/source filter →
                                           2022-7 dedup → FEC matrices →
                                           JitterBuffer insert (+ recovered pkts)
decode worker                              decode-on-demand: fills a SHALLOW
                                           ring to a 2-block high-water mark —
                                           the latency budget lives in the
                                           jitter buffer where the servo can
                                           steer it. pop/skip → depacketize →
                                           decode (LBRR recovery → PLC fallback)
                                           → AudioProcessor → WatermarkTone
                                           (unseated) → AdaptiveResampler →
                                           FloatSpscRing
device callback (ASIO/ALSA/Sim, playback-only)   ring copy or silence; zero alloc/lock
```

Loss adjudication: a gap at the cursor is only *skipped* (declared lost) when
it is OVERDUE — buffered depth already past the servo target — because below
that a 2022-1 recovery or a slow-leg straggler can still fill it; meanwhile
concealment covers the output without moving the cursor. When a loss IS
declared and the successor packet is buffered, an LBRR-capable stream (Opus
in-band FEC) reconstructs the frame from the successor before falling back to
codec PLC. Prebuffering primes the ring before Playing (no startup underruns)
and, with FEC configured, holds until the first parity packet has taught the
matrix span (bounded at >110 buffered packets — a matrix is ≤ 100).

## D5 — Clock recovery (no PTP)

The sender's audio clock and the receiver's soundcard clock are unlocked; the
drift shows up directly as jitter-buffer depth drift. A PI servo (decode
worker, once per block) steers a variable-ratio resampler
(`NAudio.Dsp.WdlResampler.SetRates`) around the device rate: control variable
= smoothed buffered depth (jitter buffer span + playout ring) vs the
configured target; output clamped ±500 ppm, slew-limited to stay inaudible.
Startup prebuffers to target before playing; sustained emptiness ⇒ conceal →
`StreamLost` (silence, servo frozen) → re-prebuffer on next packet; gross
overrun (sender restart) ⇒ hard resync (flush + re-prebuffer, `resyncs++`).

## D5b — Receive-stream statistics (the codec panel)

The decoder surfaces the operator-facing health table hardware codecs
(Tieline-style "Codec Receive Streams") show, per decoder in the status file
and SPA: Session Count (SSRC locks + relocks), Decoder Changes (Opus TOC
config changes; MP3 header changes when that codec lands), Bitrate / Sample
Rate Changes (real for MP3's per-frame headers; structurally 0 for CBR Opus
and AAC), Packets Expected (unique arrivals + declared losses — robust across
seq wrap), Packets Received total and per-leg **unique contribution**
(only-A / only-B / both, from a per-slot path mask in the jitter buffer — the
2022-7 effectiveness numbers), Corrupt Packets (RTP parse + depacketize +
decode failures), Lost Packets / Lost Samples (post-merge, post-FEC),
Overflow Events (window resets + hard resyncs), Underrun Events (device),
and Samples Decoded. Percentages are computed UI-side.

## D6 — Codecs

- Opus: Concentus (managed, already in-tree) — encoder CBR, optional LBRR;
  decoder float32, `decode_fec` recovery then PLC.
- AAC: the vendored `libfdk-aac-2` already exports the decoder API —
  `fdkAacDecoder.cs` P/Invokes `aacDecoder_{Open,ConfigRaw,SetParam,Fill,
  DecodeFrame,GetStreamInfo,Close}` (concealment via `AACDEC_CONCEAL`); no
  `NativeResolver` change. ASC built from config (LC 2-byte; HE explicit
  hierarchical AOT 5/29).
- MP3: NLayer (managed, MIT) — removes a native decode crash surface; LAME's
  `hip` is the documented fallback.
- aptX (Standard, AIR-189): clean-room managed port (`Airlock.Streaming/Aptx/`)
  of the public 4-subband QMF + ADPCM algorithm — encoder *and* decoder, no
  natives, no copyleft. The numeric tables (QMF coeffs, quantiser
  interval/dither/select) are functional constants from the expired Standard
  aptX patents; ffmpeg/libfreeaptx were an algorithm reference only. Proven
  **bit-exact** against ffmpeg's `aptx` codec in the test-suite (encoder
  byte-identical, decoder sample-identical), so it interoperates with any RFC
  7310 peer. Stereo-only (the eighth-sample sync parity couples both channels);
  16-bit PCM promoted to the codec's native 24-bit by `≪8`. **No in-band FEC and
  no PLC** — a lost packet leaves the ADPCM predictors stale until they
  re-converge, so aptX leans entirely on the 2022-1 FEC / 2022-7 dual-path
  layers; on an unrecovered gap the decoder emits silence and holds state.
  Only the patent-clear Standard variant is ported — HD tables/codewords are
  deliberately omitted.

**aptX patent/trademark posture (must clear before a release ships aptX):** the
core Standard aptX patents are expired (EP0398973/EP0400755, 2009), so the
algorithm is implementable; but **"aptX" is a live Qualcomm trademark** — the UI
and marketing describe it as "aptX-compatible", never "aptX™-certified", and
never use the Qualcomm logo/branding without a trademark licence. A one-page
patent-clearance + trademark memo from counsel gates enabling aptX in a shipped
build (tracked on AIR-189).

## D7 — Redundancy (master/backup) policy

- RTP **send** is an outward emitter: it must honor `SuppressExternalOutputs`
  — rides the existing ASUP suppress record into the encode child
  (`RtpSender.Suppressed`), so a locked backup never dual-emits.
- The **decoder keeps running on a locked backup**: like audio delay channels
  (which have no suppression hook) it drives local soundcard hardware and only
  *consumes* from the network — it cannot double-fire the plant, and a warm
  backup monitor feed is exactly what operators want.
- `audioDecoders` is a replicated collection (SyncCollections/ApplyOrder/
  SyncApplier + hooks); device names ride the docs like audio delay channels'.
  No new SettingsDoc fields.

## D8 — Licensing

New `ADECODE=n` seat pool, exact mirror of `AENCODE` (`EncodeService.
EffectiveSeats`, lowest-id-first, unseated ⇒ `Watermarked` in child config ⇒
`WatermarkTone` bursts over the soundcard output). RTP sends ride the
encoder's existing AENCODE seat/watermark.

## D9 — Data side-channel: GPIO + TCP/UDP with the audio (AIR-191..194)

iPort-style transparent carriage of Axia GPIO and TCP/UDP data messages
alongside the audio, unicast or multicast, with provable alignment.

**Wire (AIR-191):** a second RTP stream per output on **destPort+6** (the
+2/+4 FEC convention continued), dynamic **PT 99** (reserved by config
validation), sharing the audio stream's **SSRC and timestamp clock/epoch**.
Payload = `[u8 version][u8 count]` then TLV events
`[kind][slot][u32 id][u32 audioTs][u16 len][bytes]` — kinds gpioLevel /
gpioPulse / data / keyframe. Every event carries the audio RTP timestamp it
belongs to.

**Alignment contract:** the encode child stamps each event with the packager's
*current* audio timestamp (the sample about to be encoded); the decoder holds
events and releases each when playout crosses its timestamp — sample-accurate
through the jitter buffer at any depth, identical for unicast/multicast/2022-7.

**Loss handling — re-carriage, not FEC:** events are sparse and tiny, so each
event is carried in `Repeats`=3 packets, at most once per pump tick (~one
ptime apart — time diversity against burst loss), deduped at the receiver by
event id (SRTP-style replay window). A **1 Hz keyframe** restates all known
GPIO slot levels — healing residual loss, bootstrapping multicast late-joiners,
and doubling as the channel's liveness heartbeat. 2022-7 legs carry the same
datagrams byte-identically (single packet build), dedupe is the same id window.

**Ingress (AIR-191/193):** Control resolves GPI edges (`LwrpDeviceManager`)
and data messages (routes gain a `rtpData` send kind — optionally
channel-delayed for free) to **ADTA** ring control records (the APRM/ASUP/ACUE
pattern); the child is dumb carriage. GPIO addressing on the wire is a small
**slot** number — both ends map slots to (device, port) locally, no device
identities on the wire.

**Egress (AIR-192/193):** decoder child receives on listenPort+6 (data socket
beside the FEC sockets), releases at playout, hands released events to Control
(localhost datagram — the 1 Hz status file is too slow for GPIO); Control fires
GPOs via the existing `LwrpGpoDriver` and surfaces data as a **virtual data
receiver** (script triggers/routes/sends work unchanged). GPO firing and data
emission are outward emitters → they respect `SuppressExternalOutputs`
(decoder audio keeps playing on a locked backup; contacts never double-fire).

**Limits:** one data message ≤ 200 B end to end (ADTA control-slot budget);
oversize is counted and dropped, never truncated. Carriage is of *live* GPI
against the currently-encoded audio (the iPort model) — aligning GPIO to a
profanity-delayed feed remains the local GpioDelayRelay/data-route depth
machinery's job, composable via routes.
