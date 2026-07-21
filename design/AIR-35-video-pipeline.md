# AIR-35 — Encode video pipeline (Encode E4)

Status: accepted (encode design D6, docs/design/encode-option.md). Verified
2026-07-08 on the Linux dev box (GStreamer 1.20.3): tier-2/tier-3 encoders
streaming analyzer-clean TS over SRT in both modes, tier-1 rejected cleanly.

## Shape

`Airlock.Encode` hosts the pipeline via a **hand-rolled GStreamer P/Invoke
layer** (`Gst.cs`, ~15 entry points — same pattern as Airlock.Interop's NDI
binding, deliberately not gstreamer-sharp). The launch string is assembled by
`EncodePipeline.BuildLaunch` (pure, unit-tested) from the per-channel config:

```
appsrc (caps from config, leaky) ! videoconvert ! [deinterlace !]
{videoEncoderElement} ! h264parse config-interval=-1 !
video/x-h264,stream-format=byte-stream,alignment=au ! mux.sink_{pid}
mpegtsmux name=mux alignment=7 ! srtsink uri=… latency=… [passphrase/pbkeylen] [streamid]
```

- **Encoder tiers (D6)**: the element fragment is config
  (`nvh264enc…` shipped default / `openh264enc` BSD fallback / anything the
  customer installs). At startup the child probes the element — existence
  check, then a videotestsrc burst through it to fakesink — and exits with a
  distinct code (3) and a clear message when it's missing or broken; the
  supervisor surfaces that in `lastError`.
- **Video PID** rides the tsmux request-pad name (`mux.sink_256` → PID 256).
- **SRT**: listener (`srt://0.0.0.0:port?mode=listener`,
  `wait-for-connection=false` so an unsubscribed listener never stalls) or
  caller; latency, AES passphrase (write-only via API, 10–79 chars) +
  pbkeylen, streamid.

## Two non-obvious pipeline requirements (both bitten live, both test-pinned)

1. **`stream-format=byte-stream` must be forced** between h264parse and the
   mux. Left to negotiation, h264parse hands the mux AVC form, parameter sets
   stay out-of-band, and a mid-stream SRT joiner can never decode
   ("non-existing PPS 0" forever).
2. **`mpegtsmux alignment=7`** (7×188 = 1316 B = SRT live payload size).
   Without it the mux emits variable-size buffers and `srt_sendmsg` silently
   drops anything larger — which is precisely the IDR bursts, so receivers
   get an undecodable P-frame-only stream while ~full bitrate flows.

## Pixels

The child picks its source at startup: real UYVY from the ring when the tap
carries a full raster (NDI mode, geometry set by the supervisor from the
bound format), else a synthesised I420 pattern **paced by ring frames** —
moving bar + frame ticker, chroma tinted by the aired `SourceKind`
(Live grey / Fill green / Delay blue / HoldLast red), so delay transitions
are visible in any SRT player during ENGINE-SIM testing. PTS = frame cadence;
E5 (AIR-36) maps `OutputFrameIndex` → TS PTS for splice placement.

## Config

`ChannelDoc.Encode` (LiteDB) → written to `encode/ch{n}.json` on enable →
`--config` to the child. `GET/PUT /api/channels/{n}/encode-config` (admin;
passphrase write-only). A config PUT restarts a running child.
LiteDB round-trips empty strings as null — `EncodeConfig.Normalize()`
coalesces on every load (an NRE from exactly this crashed the child on the
first live run).

Supervision hardening from the live runs: enable/disable/reconfigure are now
strictly sequential (`DisableAsync` completes before a new Enable — a
fire-and-forget shutdown once disposed the ring the *next* child had just
attached, killing the server via a released mapping), and the tap teardown
waits out any in-flight producer write before releasing the mapped region.

## Verified on this box

- 241/241 tests; FAT cycles 100 PASS.
- x264enc (tier-3-style) listener: ffmpeg joined mid-stream, decoded 391
  frames / 7.8 s, H.264 Constrained Baseline 640×360@50 in clean mpegts.
- openh264enc (tier 2) caller + AES-128: receiver decoded 551 frames.
- nvh264enc (tier 1): clean rejection on this GPU-less box; real validation
  needs the E1 spike hardware (Windows/NVENC, d3d11deinterlace decision).
