# AIR-6 — Timecode policy table

Status: **RESOLVED 2026-07-07 — implemented** (`Airlock.Engine/TimecodeStamper`)
· relates to spec-review R6, AIR-1 (hold), AIR-2 (fill), §5, NFR-01.

## Policy

NDI `timecode` (int64, 100 ns units) per emitted frame; `timestamp` is always
left to the SDK (§5).

| Output frame | Outgoing timecode |
|---|---|
| Live (content) | incoming frame's timecode — passthrough |
| Delayed / RollingOut (content) | the buffered frame's **original** timecode — content time preserved through the delay |
| Building (fill frame) | previous emitted + nominal period (synthesized continuation) |
| HoldLast (source loss) | previous emitted + nominal period (AIR-1 rule) |

Edge behaviour (inherent, documented, never rebased):

| Edge | Timecode effect downstream |
|---|---|
| Live→Building | continuous (fill continues from last live timecode) |
| Building→Delayed | **backwards jump ≈ fill duration** (delayed content carries its original time) |
| RollingOut→Live, DUMP→Live | **forwards jump ≈ the skipped window** |
| Hold exit | jump to the current content timecode |

## Alternative rejected

Rebasing buffered timecodes to be wall-continuous across edges. Rejected
because content-time preservation is what the FAT/NFR-01 verification and
as-run reconciliation key on; NDI timecode is informational to receivers
(frame syncs pace on arrival, not timecode), so the jumps are harmless
downstream but the preserved content time is operationally load-bearing.

## Spec change request (for Cloudcast)

Replace §5's single line ("outgoing timecode = incoming") with the two tables
above; add the synthesized-frame rule to §3.1/§4.
