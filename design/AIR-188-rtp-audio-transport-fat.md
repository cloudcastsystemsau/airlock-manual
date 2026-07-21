# AIR-188 — RTP audio transport FAT report

> Factory Acceptance Test for the AIR-176 RTP audio transport (encoder `Rtp`
> output family + the `Airlock.AudioDecode` block). Follows the AIR-158 / AIR-172
> FAT pattern: run what the bench allows, capture evidence, sign off PASS/FAIL,
> and list what genuinely needs on-site kit.

## Result: PASS (bench, single box)

11/11 loopback sub-drills PASS, real-ASIO playout PASS, 3/3 third-party interop
PASS. Remaining on-site sign-off items listed at the end.

## Environment

| | |
|---|---|
| Branch / base | `feat/AIR-188-rtp-transport-fat` off `main` @ `3c94641` |
| Date | 2026-07-16 |
| Host | Windows 11 Pro 10.0.26200, .NET 8.0.401 |
| Playout hardware | **Axia ASIO x64 Driver** (test output 1) |
| Third-party decoder | **GStreamer 1.26.1** (`opusdec`, `mpg123`/`decodebin`, `avdec_aac`) |
| Tone | continuous-phase 440 Hz sine, 0.3 amplitude (ideal RMS 0.212) |

## Method

`dotnet run --project src/Airlock.TestHarness -- rtp-fat` drives the **real**
send pipeline (`RtpSendPipeline`) and **real** decoder engine (`DecoderCore`)
over **real loopback UDP sockets**, with a lossy relay in the middle standing in
for `tc netem`. Verdicts come from the decoder's own counters plus a Goertzel
440 Hz tone analyzer on the played-out PCM (0.1 s windows = 44 whole cycles at
48 kHz, zero spectral leakage). The driver is committed and reproducible; raw
evidence is emitted as JSON via `--json`.

Automated suite baseline: **215/215** transport/codec/FEC/jitter/decoder unit
tests green (`Rtp*`, `Fec2022`, `JitterBuffer`, `Aptx`, `Opus`, `Aac`, `Mp3`,
`DecoderCore`, `AudioDecoderSeat`). Note: 4 `AudioEncodeAudioProcRing` tests
flake on this Windows box with a LiteDB temp-file `File.Delete` teardown race
(the encoder child hasn't released the handle) — pre-existing, unrelated to
AIR-188 (that code is untouched), and clears when stale `dotnet` test hosts are
reaped.

## Drill A — per-codec round-trip (lossless loopback)

Every codec: `decodeErrors=0`, `concealed=0`, output RMS ≈ 0.21 (≈ ideal 0.212),
440 Hz tone purity ≈ 1.0. `ppm` is the residual offset between the two
independent software pacing clocks (sender thread vs Sim device thread), which
the servo tracks live.

| Codec | pkts | samples | RMS | tone purity | decErr | ppm |
|---|--:|--:|--:|--:|--:|--:|
| Opus 96 kbps | 275 | 262 080 | 0.212 | 1.000 | 0 | −267 |
| AAC-LC 128 kbps | 258 | 262 144 | 0.212 | 1.000 | 0 | +249 |
| AAC HE-v1 64 kbps | 129 | 262 144 | 0.211 | 1.000 | 0 | +127 |
| AAC HE-v2 48 kbps | 129 | 262 144 | 0.212 | 1.000 | 0 | +127 |
| MP3 128 kbps | 226 | 259 200 | 0.201 | 1.000 | 0 | −224 |
| aptX (Std, 4 ms) | 1377 | 262 272 | 0.212 | 0.999 | 0 | −473 |

## Drill B — SMPTE 2022-1 XOR FEC under ~20 % media loss (Opus + LBRR)

~23 % of media packets dropped independently in the relay; FEC parity + Opus
in-band LBRR reconstruct. Residual concealment is a small fraction of the stream
and the tone survives. Mirrors the AIR-176 §D2 worked example.

| Mode | dropped | FEC col | FEC row | LBRR | declared lost | concealed | conceal % | purity |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| column 5×5 | 181 | 60 | – | 100 | 120 | 24 | 3.11 % | 0.867 |
| columnRow 5×5 | 181 | 73 | 73 | 23 | 35 | 17 | 2.20 % | 0.947 |

columnRow's iterative row↔column recovery (146 rebuilds) leaves far less for
concealment than column-only, as designed.

## Drill C — ST 2022-7 dual leg

Three phases on one continuous stream: (0) healthy pair, (1) disjoint loss —
even seq dropped on leg A, odd on leg B, (2) leg B fully out.

| metric | value |
|---|--:|
| delivered by both legs (healthy) | 149 |
| 2022-7 duplicates deduped | 149 |
| unique contribution leg A / leg B | 374 / 150 |
| declared lost | **0** |
| concealed | **0** |
| tone purity | 0.999 |

Healthy pair shows duplicates ≈ received/2 (the merge working); disjoint loss
and a full leg outage produce **zero** audio loss — every packet arrived on at
least one leg. The path gap shows as a per-leg statistic, not as audio loss.

## Drill D — clock-recovery soak (45 s)

Device clock set +150 ppm off the stream (deviceSampleRate 48007 Hz vs 48000).

| metric | value |
|---|--:|
| servo steering (settled, last third) | −144 ppm (σ 17 ppm) |
| buffer depth (mean) vs target | 70 ms vs 60 ms |
| device underruns | **0** |
| hard resyncs | **0** |
| samples decoded | 2 183 040 |
| tone purity | 1.000 |

The PI servo converged to cancel the ~150 ppm offset and held it flat (σ 17 ppm)
for 45 s with no underruns and no resyncs. The real-ASIO run below independently
confirms clock recovery against a true hardware clock (−48 ppm Axia offset).

## Drill E — sender suppression (master/backup locked-backup mute)

| phase | output RMS | decoder state |
|---|--:|---|
| playing | 0.212 | Playing |
| suppressed | 0.000 | **StreamLost** |
| unsuppressed | 0.212 | Playing |

`RtpSender.Suppressed` stops every datagram (a locked backup emits nothing on the
wire); the decoder goes silent → StreamLost, then resumes glitch-free on
unsuppress with `decodeErrors=0` throughout. This is the "sender mute on locked
backup, decoder keeps playing" contract (AIR-176 §D7).

## Real-ASIO playout sign-off

`rtp-fat --asio "Axia ASIO x64 Driver"` — Opus 96 kbps → loopback UDP → decoder
→ Axia output, 10 s, audible 440 Hz tone confirmed:

```
state=Playing samplesDecoded=502080 underruns=0 resyncs=0 concealed=0 decodeErrors=0 ppm=-48
```

`ppm=-48` is the **real** offset between the Axia hardware clock and the sender —
the servo locked to it (far tighter than the ±200 ppm software-clock case), 0
underruns over the run: genuine hardware clock recovery.

## Third-party interop (GStreamer 1.26.1)

`build/fat-rtp-interop.ps1` — the real send pipeline emits each codec to a UDP
port; a wholly independent RFC decoder (GStreamer) depayloads + decodes to a WAV,
verified to carry the 440 Hz tone. Proof the wire format is RFC-decodable by
something that is not Airlock.

| Codec | GStreamer chain | decoded RMS | purity | verdict |
|---|---|--:|--:|---|
| Opus (RFC 7587) | `rtpopusdepay ! opusdec` | 0.212 | 1.000 | PASS |
| MP3 (RFC 2250) | `rtpmpadepay ! decodebin` | 0.201 | 1.000 | PASS |
| AAC-LC (RFC 3640) | `rtpmp4gdepay ! avdec_aac` | 0.212 | 1.000 | PASS |

aptX (RFC 7310) has no depayloader in this GStreamer build; its interop is
already proven **bit-exact against ffmpeg's `aptx` codec** in `AptxCodecTests`.

## Remaining for on-site sign-off

The single-box bench cannot fully substitute for the field drill. Outstanding:

1. **Genuine two-machine run** over a real network (this drill is loopback on one
   host — timing, MTU, and OS UDP paths are real, but the wire is not).
2. **Dual physical NIC 2022-7 path diversity** across separate switches/paths
   (loopback used two UDP ports on one host; leg identity + merge are exercised,
   physical path diversity is not).
3. **Real network impairment** — packet loss / reordering / jitter via Linux
   `tc netem` (software relay drop stood in; FEC/2022-7/servo *logic* is
   exercised, real-wire statistics are not).
4. **Third-party hardware STL codec** interop (Tieline / APT / Prodys) — a soft
   RFC decoder (GStreamer/ffmpeg) stood in for a broadcast hardware peer.
5. **aptX patent/trademark counsel memo** before any shipped build enables aptX
   (tracked on AIR-189).

## Reproduce

```bash
dotnet run --project src/Airlock.TestHarness -- rtp-fat --json fat.json     # drills A–E
dotnet run --project src/Airlock.TestHarness -- rtp-fat --asio "Axia ASIO x64 Driver"
pwsh build/fat-rtp-interop.ps1                                              # GStreamer interop
```
