# AIR-7 — Rollout ends in a jump cut: confirmed

Status: **CONFIRMED 2026-07-07** — SCA (D. Jackson) accepts skip-to-live as
the intended ROLLOUT behaviour, consistent with the AIR-1 hold-matrix
acceptance · relates to spec-review R7, §4, FR-70.

## The behaviour

During RollingOut, recording is off: the buffer plays out at real time while
newly arriving content is discarded. Return-to-live therefore lands with a
**forward content jump equal to the pre-rollout depth**. Rollout duration =
depth at the moment the command lands.

## Why this is the right call

A "seamless" return (no content loss) is not achievable at real time — the
buffer can only drain if playout runs faster than the input, which is not
acceptable on air. The delay exists for incident protection; the skipped
window is the *point* of rolling out. Timecode across the jump follows the
AIR-6 table (forward jump, content time preserved); standalone metadata in
the skipped window is dropped-with-alarm, never sent late (AIR-5); audio
takes a 5 ms edge fade at the jump (AIR-2).

## Operator-facing implications (for UI/training docs)

- TALLY shows RollingOut for exactly `depth` seconds; the dashboard depth
  counts down to zero, then Live.
- Content between the rollout command and return-to-live never airs. If it
  must air, the operator waits (stays Delayed) instead of rolling out.
- FR-70 auto-insert on rollout: the splice-end fires at rollout *start*
  (subject to the per-channel enable flag); the skipped window does not
  generate additional triggers.

## Spec change request (for Cloudcast)

§4: state the jump explicitly ("RollingOut discards input; return-to-live
skips forward by the drained depth") so the SOW behaviour is unambiguous at
FAT.
