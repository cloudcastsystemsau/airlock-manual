# Browser audio confidence monitoring — design plan

Status: **DECIDED 2026-07-07 — Option B (Opus) selected by SCA, implemented**
(AIR-22: AudioStreamHub, OpusTapStreamer, /ws/audio/{n}/{in|out}, AudioMonitor
UI; verified live — sim tone streamed at 96 kbps, C# encode/decode round-trip
asserts the tone survives).
Dan wants WAN-grade compressed monitoring rather than LAN-only PCM ·
extends the preview/meter confidence monitoring: hear the input and output
taps in the browser, not just see them.

## Decision notes (option B specifics)

- **Encoder:** Concentus (pure managed C# port of libopus, MIT, NuGet) — no
  native dependency, fits the supply-chain rules; 48 kHz stereo @ 96 kbps,
  20 ms packets (960 samples/frame).
- **Transport:** one Opus packet per WS binary message on
  `/ws/audio/{n}/{in|out}?access_token=…` after a JSON hello
  (`{codec:"opus", sampleRate, channels, frameMs}`) — same hub + JWT
  pattern as previews; slow listeners drop-oldest, never back-pressure air.
- **Decoder:** browser WebCodecs `AudioDecoder` (raw Opus packets as
  `EncodedAudioChunk`s) → AudioWorklet ring buffer (~250 ms jitter buffer).
  Browsers without WebCodecs get a clear "unsupported" state (WASM decoder
  is the documented fallback if ever needed).
- **Sim mode:** input tap synthesises a 1 kHz tone, output tap 440 Hz, so
  the full encode→stream→decode path is testable without NDI and the two
  taps are audibly distinguishable.
- **Sample rates:** any source rate; non-48 kHz taps (a 44.1 kHz file played
  as NDI, a decoder passing a stream's native rate) resample to Opus's
  48 kHz on the streamer's worker task (`MonitorResampler`, WDL resampler —
  pure managed). *(Originally a v1 constraint: non-48 kHz taps were silently
  dropped, which read as "monitoring is broken" on 44.1 kHz sources.)*

## Requirements

- Listen to either tap (input = source as received, output = programme,
  i.e. delayed) per channel, from the web console.
- Same auth as previews (JWT); management-LAN deployment.
- Zero impact on the frame path when nobody is listening (NFR-04); a slow
  listener must never back-pressure air.
- Latency comparable to the ~5 fps JPEG preview (≲300 ms), so audio and
  video confidence line up — this rules out segment-based streaming.

## Options

### A. Raw PCM over WebSocket + Web Audio API  ⭐ recommended
Server taps the audio already flowing past the meters, downmixes to stereo
s16 @ 48 kHz, chunks ~20 ms, and pushes binary frames over
`/ws/audio/{n}/{in|out}` (same hub pattern + JWT query auth as previews).
Browser plays via an AudioWorklet ring buffer.

- ✅ No new dependencies server- or client-side; mirrors the proven
  PreviewHub architecture.
- ✅ ~1.5 Mbps per listener — trivial on the management LAN (4 taps ×
  3 listeners ≈ 18 Mbps worst case).
- ✅ ~150–300 ms end-to-end; input vs output taps audibly demonstrate the
  delay working.
- ⚠ Uncompressed — not for WAN/remote monitoring (that's option B later).

### B. Opus over WebSocket (WebCodecs / WASM decode)
~48 kbps per listener; right answer if remote monitoring over WAN ever
becomes a requirement. Adds a codec dependency (managed Concentus or native
libopus) and a browser-decode matrix. **Defer** — the hub interface below is
codec-agnostic, so Opus drops in as an alternative encoder without touching
the taps.

### C. HLS/LL-HLS via ffmpeg
Simplest client (`<audio>` tag) but 2–10 s latency — useless next to a
300 ms video preview — plus an ffmpeg process per tap and segment churn.
**Rejected.**

### D. WebRTC
~100 ms and built-in Opus, but drags in an ICE/DTLS/SRTP stack and
signalling for a LAN confidence feed. Overkill. **Rejected.**

## Design (option A)

**Server**
- `AudioStreamHub` (sibling of PreviewHub): subscribers keyed by
  (channel, tap). Engine/relay audio paths already touch every buffer for
  metering; add one call — `hub.Publish(ch, tap, planes, samples, rate,
  channels)` — guarded by a volatile `HasSubscribers` check so the cost is
  one branch when nobody is listening.
- Publish path (never blocks): downmix first two channels (planar float →
  interleaved s16), copy into a pooled chunk, `TryWrite` to each
  subscriber's bounded channel — **drop-oldest** on a slow listener.
- WS endpoint `/ws/audio/{n}/{in|out}?access_token=…`: JSON hello
  (`{sampleRate, channels:2, format:"s16le"}`) then binary PCM frames.
- ENGINE-SIM: input tap generates a 1 kHz −18 dBFS tone (output tap silent
  until delayed) so the whole path is testable without NDI.

**Browser**
- Speaker toggle per tap next to the existing meters (the click satisfies
  the autoplay-gesture requirement). Only one tap audible at a time
  (auto-mute the other) + volume slider.
- `AudioContext` (48 kHz) + `AudioWorklet` ring buffer (~250 ms jitter
  buffer, underrun = silence). Worklet JS ships as a static asset.
- "MONITORING" badge while live, mirroring the preview's live state.

**Non-goals (v1):** >2-channel monitoring (downmix only), WAN-grade
compression (option B), recording.

## Estimate

Server hub + tap wiring + sim tone: ~½ day. Worklet player + UI: ~½ day.
Tests (hub drop behaviour, downmix correctness, endpoint auth) + polish: ~½.
