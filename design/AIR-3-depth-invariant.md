# AIR-3 — Depth invariant & FIFO-full policy

Status: **RESOLVED 2026-07-07 — implemented** · relates to spec-review R3,
FR-16, FR-22/23, NFR-01.

## Invariant

`fill.FrameCount ≤ maxDepthFrames` where
`maxDepthFrames = ceil(maxDepthSeconds × fps)` from channel config. Depth
after Building equals the fill length (FR-16), so an oversized fill can never
fit the buffer — it is rejected **at fill-assign time** with a distinct
result (`FillAssignResult.ExceedsMaxDepth`, HTTP 400), exactly like the
format-hash rejection (FR-22). Boundary is inclusive (fill == maxDepth is
legal).

## FIFO-full policy

`DelayFifo` enforces the **exact configured ceiling** (`maxDepthFrames`), not
the power-of-two ring size underneath it. On a full buffer the write is
refused: the frame is routed live-only, `ChannelEvent.FifoOverflow` fires
(→ `ALARM_FIFO_OVERFLOW` + audit), and **nothing is ever overwritten** — the
delayed content on air is sacrosanct. With the AIR-1 pacer the output never
stalls, so depth cannot exceed the fill length in normal operation; overflow
is a defensive invariant, and any occurrence is a bug to investigate, not a
condition to paper over.

## Spec change request (for Cloudcast)

§3.2/§3.3: state the invariant and the assign-time rejection; define
FIFO-full as reject + alarm (never overwrite); note the boundary is
inclusive.
