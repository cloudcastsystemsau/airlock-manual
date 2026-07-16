# AIR-88 — Rollout mix-minus studio return

Status: **IMPLEMENTED 2026-07-10** — SCA direction; extends the audio delay
(AIR-49..56), the AIR-7 jump cut and the AIR-71 ping-pong crossover. Legacy
source: ProfanityDelayService `Audio/PingPongDelayBuffer.vb` (the third
"rollout" buffer), `DelayUnit/DelayUnit.vb` (`startExit`, `GetRollOutOutput`,
`exitoverlaptimeMS`), `Audio/ccAsioOut.vb` (`asiorolloutoffset`).

## The problem

An audio ROLLOUT exit is a jump cut (AIR-7): the delayed programme is
abandoned, the main output crossfades to live over 10 ms and the buffered
tail never airs. That is deliberate — the skipped window is the *point* of
rolling out. But in the studio the presenter has just been listening to the
delayed feed, and at the instant of the cut their monitoring has nowhere to
go: they cannot hear the tail play out, and if they monitor the (now live)
main output they hear themselves at zero delay.

Legacy solved half of this. It drained the retiring buffer at unity onto a
**separate ASIO channel** (`asiorolloutoffset`, e.g. "Livewire 7 Left") so the
tail could still be heard, and `exitoverlaptimeMS` timed how the pre-filled
live buffer came into the main mix. A true N-1 return was scoped but never
shipped: `rolloutMixMinus` / `RollOutMixMinusWaveOutDeviceID` exist only as
commented-out settings in `ProfanityDelay.vb`. Airlock inherited the gap in the
other direction — `AudioDelaySettings.RolloutChannelOffset` has existed since
AIR-52 and was never read by anything.

## The behaviour

On a ROLLOUT exit, with the return enabled:

- **The main output is unchanged.** AIR-7 jump cut, AIR-71 ping-pong swap,
  same 10 ms equal-power crossfade to the pre-filled live ring. Settled
  behaviour; not re-litigated.
- **The retiring delayed ring is not discarded.** It keeps draining at unity
  (tempo 0) through the same stretcher — so nothing is lost or repeated at
  the seam — until the ring and the stretcher's pipeline are empty. The drain
  therefore lasts about the delay depth at the moment of the exit.
- **The return output carries `drainingDelayed − liveInput`** — the N-1 the
  studio monitors. The presenter hears the tail play out, and never hears
  themselves.
- **`RolloutOverlapMs`** (default 250 ms, the legacy `exitoverlaptimeMS`) is an
  equal-power envelope: the return fades in as the rollout begins and fades
  out over the last such window of the drain, so the monitor never opens or
  closes on a hard edge.

### Chosen deviations / clarifications (SCA direction, 2026-07-10)

- The return source is the **drained delay buffer**, not a tap of the main
  output — at the jump cut the main output *is* live, so a mix-minus of it
  would be silence.
- The main output keeps the jump cut. The return is a **separate output**, not
  a change to what airs.
- Routing is by **ASIO channel offset** (wiring the dormant
  `RolloutChannelOffset`), with an extra ALSA pair and the sim core for test.

### Interactions

- **Compress exits have no return.** The delay is unwound on air; there is no
  retiring ring to drain. `RolloutReturnEnabled` is ignored unless
  `ExitMode = rollout`.
- **BUILD or COUGH during a drain abandons it.** Both reclaim the ring and the
  stretcher, so the return ramps to silence over ~5 ms rather than cutting.
  An abandoned drain never fires `RolloutDrained`.
- **Censors survive the swap.** Both ping-pong rings are written the same
  frames every tick, so they share one absolute frame-index space and a censor
  region marked before the exit still lands on the drained tail. Content the
  operator censored is censored on the studio return too.
- **Depth reads zero during the drain.** The main output is live; the
  stretcher's remaining content belongs to the return, not to air.
- The drain ends when the ring is empty *and* the stretcher yields nothing
  more. SoundTouch always retains a small unprocessable residue, so "ring and
  pipeline are empty" never becomes literally true.

## Airlock design

`AudioDelayCore` gains a third output span
(`Tick(input, output, postOutput, returnOutput, frames)`; the older overloads
sink the outputs they omit). All scratch is pre-allocated in the constructor —
the tick path stays allocation- and lock-free (NFR-04). `WorkerRingDelay`
carries the return on its own SPSC ring (`FillReturn`), exactly as AIR-79 (b)
did for the post-censor output, and now exposes `BlocksProduced` — bumped after
every output ring is written, so a device (or a test) can wait for a block
without racing the counters the core advances mid-tick.

Device routing:

| Backend | Main | Post-censor (AIR-79 b) | Rollout return (AIR-88) |
|---|---|---|---|
| `asio` | `OutputChannelOffset` | not routed yet | `RolloutChannelOffset` |
| `alsa` | channels `0..C` | next pair up | next pair up again |
| `sim`  | computed | computed | computed |

NAudio exposes one driver-level `ChannelOffset`, so the ASIO backend renders
one contiguous output block from `OutputChannelOffset` and writes silence into
any device channels between the main and return pairs. `Validate()` therefore
requires `RolloutChannelOffset >= OutputChannelOffset + Channels`.

Fixed along the way: `AsioAudioDevice` passed `null` as NAudio's playback
provider, which sets `NumberOfOutputChannels = 0` — the callback's
`OutputBuffers` array would have been empty and no output could ever have been
written. It now passes a silent provider sized to the output block, purely to
declare the channel count (it is never read; the callback sets
`WrittenToOutputBuffers`). ASIO remains unvalidated against real hardware —
there is no Windows box in the loop.

## Test plan

`tests/Airlock.Tests/AudioRolloutReturnTests.cs`:

- Mix-minus identity: build on a 0.5 DC level, roll out while the studio feeds
  0.2 → main is 0.2, return is 0.3.
- The drain runs for about the depth buffered at the exit, then ends, counts
  one `RolloutDrained`, and goes silent; frames in == frames out.
- Fade in / fade out over the overlap window; silence until the exit.
- BUILD mid-drain abandons it without a click; COUGH mid-crossfade the same.
- Successive rollouts each drain, and the ping-pong swap still alternates.
- A censor marked before the exit silences the drained tail on the return.
- The worker ring carries the return without starving; the device-side pops
  stay allocation-free (`WorkerRingDelayTests`).
- ALSA playback width / slot maths for every pair combination.

## Out of scope

- Routing the post-censor pair on ASIO (still ALSA-only; needs its own channel
  offset setting and Windows validation).
- Exposing `RolloutDraining` / `RolloutDrainMs` on the heartbeat and the audio
  card — the 64-byte control block has no room without a format change.
- A return output for compress exits (there is nothing to drain).
