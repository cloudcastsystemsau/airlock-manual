# AIR-5 — Standalone metadata release indexing

Status: **RESOLVED 2026-07-07 — implemented** · relates to spec-review R5,
FR-61, FR-64.

## Index definitions (the precision R5 asked for)

- **inputFrameIndex** — monotonic per-channel counter stamped by the RecvLoop
  on every captured video frame at arrival; stored in
  `SlotHeader.InputFrameIndex` and preserved through the delay. Standalone
  metadata frames are tagged with the inputFrameIndex of the most recent
  video frame at their arrival.
- **airedInputFrameIndex** — the `InputFrameIndex` of the video slot emitted
  on PGM this output period. Only Live and Delay emissions air content; Fill
  and HoldLast frames do **not** advance it. This is *not* the output frame
  counter — the two align only in steady state, which was the spec v0.2
  ambiguity (§7.1 compared an output counter to an input counter).

## Release rule (`Airlock.Engine/MetadataReleaser`, run per aired frame)

1. **Skip windows:** entries tagged inside `(lastAired, aired)` exclusive are
   dropped with `ALARM_SCTE_IN_SKIP` + audit (FR-64). The aired index
   advances by exactly 1 in normal playout, so the window is empty; it opens
   only across a DUMP flush or the RollingOut→Live jump.
2. **Release:** entries tagged `≤ aired` are released in arrival order via
   `send_send_metadata` (FR-61).

## Defect found and fixed while implementing

The queue-level `TryReleaseDue(aired)` alone would have **released
skipped-window entries late** at the RollingOut→Live jump (aired jumps
forward past their tags, making them "due"), sending stale SCTE messages on
the return-to-live frame — an FR-64 violation the spec's own wording invites.
The window-drop in step 1 runs before release, closing this for rollout,
DUMP, and any other forward jump uniformly. (The DUMP notification handler
also drops its exact flushed window immediately for audit fidelity; the
releaser is the backstop.)

## Spec change request (for Cloudcast)

Rewrite §7.1's release condition from
`outputFrameIndex == frameIndexAtArrival` to the definitions and two-step
rule above, and note explicitly that rollout jumps are a skip window for
standalone metadata (FR-64 currently names only ROLLOUT/DUMP "skipped
window" without defining it).
