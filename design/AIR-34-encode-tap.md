# AIR-34 — EncodeTap + Airlock.Encode process isolation (Encode E3)

Status: accepted (encode design D1/D2/D3, docs/design/encode-option.md).
Exit criteria met 2026-07-08: kill -9 mid-air → PGM unaffected (+309 frames
during the outage), auto-restart, ALARM_ENCODE_DOWN raised and cleared.

## Ring (Airlock.Engine/EncodeTap.cs)

Seqlock **broadcast** ring in a file-backed memory-mapped file
(`encode/ch{n}.ring`) — chosen over a classic SPSC queue because it makes the
FR-87 backpressure contract structural:

- The producer (engine output thread) **always writes**, overwriting the
  oldest slot. It cannot block, fail, or allocate — drop-oldest is not a code
  path, it's the data structure. NFR-04 holds: pointer stores + span copies
  into the mapped region only.
- Each slot carries a sequence word written twice (odd = writing, even =
  complete). The consumer validates it around its copy; on a lap it re-syncs
  to the oldest surviving frame and reports how many it missed.
- Layout: 4 KiB header (magic/geometry + producer/consumer cursors,
  wall-clock heartbeats, drop counter), frame slots (64 B stamp + video +
  audio, sized from the active pool's slot geometry), control slots.
- The **control ring** (64 × 256 B, same mechanics) is the E5 trigger
  sideband (design D3) — present now so the file geometry doesn't change
  when AIR-36 lands.

Tap point: `SimLoop.EmitFrame` / `NdiDelayEngine.Emit`, after the PGM send
and before any slot recycles — the ring carries exactly what NDI viewers saw
(design D2), stamped with output/input frame index, timecode, byte counts,
format, `SourceKind`, and the AIR-2 discontinuity flag.

## Child (Airlock.Encode)

Per-channel console process, deliberately stateless: everything arrives via
the ring or argv (`--ring --channel --parent-pid`). E3 consumes-and-discards;
E4 (AIR-35) replaces the discard with the GStreamer appsrc pair. Liveness is
written into the ring header (consumed seq, cumulative drops, UTC heartbeat);
an orphan guard exits when the parent pid disappears.

## Supervision (Airlock.Control/EncodeService.cs)

Watchdog pattern: one supervised child per encode-enabled channel.

- Child exit → `ALARM_ENCODE_DOWN` + audited `ENCODE_CHILD_EXIT` + restart
  with capped exponential backoff (1, 2, 4 … 30 s).
- The alarm clears only when the child's **ring heartbeat** proves it is
  consuming (< 3 s old) — a running-but-wedged child stays alarmed.
- Registered after ChannelManager so hosted-service shutdown (reverse order)
  kills children before their channels.
- REST: `GET/POST /api/channels/{n}/encode` (viewer/admin);
  `ChannelDoc.EncodeEnabled` persists across restarts. The full encode SPA
  page is AIR-38.

## Notes for later phases

- An NDI re-bind that changes frame format needs an encode restart to
  re-size the ring — supervisor-owned, wire when E4 sizes rings from the
  bound format (ENGINE-SIM rings are 16 B header-only slots).
- `framesConsumed` in the status is the consumer's ring *position*, not a
  count — identical unless laps occurred.
- AIR-38 licence gating decision needed: the AIR-40 never-licensed grace
  grants **no feature flags**, so `HasFeature("ENCODE")` would refuse encode
  on unlicensed dev boxes — either grace grants all features, or dev boxes
  get a licence.lic.
