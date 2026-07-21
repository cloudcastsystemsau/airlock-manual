# Airlock Technical Build Specification v0.2 — Engineering Review

Reviewer: engineering review on behalf of SCA (customer)
Date: 6 July 2026
Scope: Build Spec v0.2 against SOW v0.6 intent. Findings ordered by severity.

Overall: the spec is unusually strong for a v0.2 — the threading/memory model is
credible, the zero-alloc discipline is stated as an enforceable rule, licensing
choices (SkiaSharp over ImageSharp, LGPL FFmpeg as a process, vendored MIT
interop) are deliberate and correct. The findings below are the gaps we should
resolve with Cloudcast before build sign-off.

---

## Blocking / must resolve before sign-off

### R1. Output pacing during source loss contradicts hold-last-good (§3.1, §5)
> **Resolved 2026-07-07:** Option C (unified deadline scheduler) chosen and
> implemented — see docs/design/AIR-1-output-clocking.md and AIR-1. Spec
> change request to Cloudcast outstanding.
The PGM sender is created with `clock_video=false` and the SendLoop is "paced by
input frame arrival". On source loss (§5), the channel must "hold last-good
output slot" — but with no incoming frames there is no pacing event, so the
output *stops* rather than repeating last-good. Downstream receivers see a
freeze/timeout, and any delay depth measurement stalls.

**Ask:** specify a fallback self-pacing timer (period = 1/fps from the locked
channel format) that engages after the 500 ms loss threshold and disengages on
the next received frame, including how the two pacing sources hand over without
emitting a double or short frame.

### R2. Audio path through the delay is unspecified (§3.2, §3.3)
> **Resolved 2026-07-07:** Option A (slot-paired audio, drift-free cadence,
> edge fades) accepted — see docs/design/AIR-2-audio-delay-model.md and AIR-2.
The FIFO is defined as a ring of video slot indices. Audio slots are mentioned
in the pool sizing but nothing defines: (a) whether audio rides in the same
slot as its video frame or in a parallel ring, (b) the A/V pairing rule when
audio frame boundaries don't align to video frames (48 kHz @ 50 fps = 960
samples/frame is clean, but 59.94 rates are not), (c) what happens to audio
during DUMP flush and at the RollingOut→Live jump (hard cut = audible click;
is a fade required?). For a radio-originated customer this is the part we care
most about.

**Ask:** an explicit audio model — pairing, drain rules per state transition,
and click mitigation at DUMP/rollout boundaries.

### R3. FIFO overflow vs fill length vs maxDepthSeconds (§3.2, §4, §6)
> **Resolved 2026-07-07:** invariant + reject-never-overwrite policy
> implemented — see docs/design/AIR-3-depth-invariant.md and AIR-3.
Depth after Building completes equals the fill duration, and the pool is sized
from `maxDelaySeconds`. Nothing states the invariant `fill.FrameCount ≤
maxDepthSeconds × fps`, nor what the writer does if head catches tail
(overwrite oldest? drop newest? alarm?). A fill assignment that exceeds the
configured max depth should be rejected at assignment time, same as the
format-hash check (FR-22).

**Ask:** define the invariant, enforce at fill-assign time, and specify FIFO
full behaviour as a hard invariant violation (alarm + defined policy), not UB.

### R4. NDI "< 30 days" CI gate will block releases spuriously (§2, §14.1)
> **Resolved 2026-07-07:** gate reimplemented in `build/check-ndi-age.ps1` —
> fail if unpinned or pinned ≠ latest available SDK; warn (not fail) at
> >30 days. Licence-wording confirmation with Cloudcast still open (AIR-4).
As written, CI "fails the release job if the pinned NDI runtime is older than
30 days". If NDI (the vendor) hasn't published a new SDK within 30 days of our
release date, no compliant release is possible. The licence obligation is to
ship a current SDK, not one under 30 days old.

**Ask:** restate the gate as "pinned runtime == latest publicly available SDK
at release time (warn at 30 days)", and confirm the actual licence wording
this rule is derived from.

---

## High — resolve during detailed design

### R5. Standalone metadata release indexing is ambiguous during Building (§7.1)
> **Resolved 2026-07-07:** indices defined + release rule implemented
> (`MetadataReleaser`); also fixed a latent FR-64 violation (late release of
> skipped-window entries at rollout jumps) — see
> docs/design/AIR-5-metadata-release-indexing.md and AIR-5.
Release condition is `outputFrameIndex == frameIndexAtArrival`. If
`outputFrameIndex` counts frames *sent* and `frameIndexAtArrival` counts frames
*received*, these are the same counter only in steady state. During Building
the output is fill while input records, and the intended behaviour (release
when the *content frame* it arrived with airs) requires comparing against the
dequeued slot's original input index, not the output counter.

**Ask:** define both indices precisely; release key should be the input frame
index stamped on the slot being aired.

### R6. Timecode behaviour for fill and at state edges is undefined (§5, §4)
> **Resolved 2026-07-07:** policy table defined and implemented
> (`TimecodeStamper`) — content passthrough, synthesized continuation for
> fill/hold, documented jumps at edges. See
> docs/design/AIR-6-timecode-policy.md and AIR-6.
Outgoing timecode = incoming timecode is documented for the delay path, but:
what timecode do fill frames carry during Building? And at Building→Delayed the
output timecode jumps *backwards* by the fill duration; at RollingOut→Live it
jumps *forwards* by the residual depth. Downstream frame syncs and as-run
loggers need this documented (NFR-01 verification itself keys on timecode).

**Ask:** a timecode policy table per state and transition.

### R7. RollingOut ends in a jump cut — confirm this is the SOW intent (§4)
> **Confirmed 2026-07-07:** skip-to-live accepted by SCA as intended
> behaviour — see docs/design/AIR-7-rollout-jump.md and AIR-7.
With recording off during RollingOut, everything received while the buffer
drains is discarded, so return-to-live lands with a forward content jump equal
to the pre-rollout depth. That is a legitimate design (skip-to-live), but the
SOW language should be checked — if a *seamless* return (no content loss) is
expected, the mechanism would instead be drain-while-recording, which never
converges without playing out faster than real time. This needs an explicit
customer decision, and the FR-70 auto-insert "splice end" on rollout must
carry the right break duration for the skipped window.

### R8. Watchdog name takeover race (§10)
> **Resolved 2026-07-07:** kill-confirm before publish; operator-confirmed
> fail-back by default; shared-state header coordinates main-process restart.
> See docs/design/AIR-8-watchdog-failover.md and AIR-8.
Failover publishes senders under the *same* NDI source names while the main
process may be mid-crash (sockets not yet closed) — two sources with one name
on one host. Also "yields names back when main heartbeats resume" implies a
second glitch on fail-back with no coordination handshake defined; an
automatic fail-back during live programming may be worse than staying on
pass-through until an operator acts.

**Ask:** define takeover sequencing (wait-for-port-release / kill-confirm
before publish), and make fail-back operator-confirmed by default.

### R9. 4 KB metadata region truncation contradicts verbatim pass-through (§3.2, §7.1)
> **Resolved 2026-07-07:** drop-with-alarm, never truncate —
> `FramePool.TryWriteMetadata` refuses oversized payloads whole; region size
> configurable per channel (default 4 KB). Standalone queue already had the
> same policy. See AIR-9.
FR-60/§7.1 promise bytes forwarded verbatim, §3.2 truncates over 4 KB with an
alarm. Truncated VANC XML is not "verbatim" — it is corrupt XML the receiver
may reject entirely. 4 KB is likely fine for SCTE-104 + 708, but the failure
mode should be *drop-with-alarm*, never truncate, and the region size should
be configurable.

---

## Medium

> **R10–R13 resolved 2026-07-07** — see docs/design/AIR-10-13-ops-hardening.md
> (AIR-10/11/12 implemented; AIR-13 conform-on-assign decision recorded).

### R10. Server-level memory admission control is missing (§3.2)
6.2 GB/channel ceiling is stated, but nothing defines channels-per-server
limits or a startup check that total pool allocation fits physical RAM with
headroom. Overcommit → paging → the exact frame drops NFR-04 exists to
prevent. Ask for an admission check at channel start and a stated reference
server spec.

### R11. Security posture gaps (§8)
No TLS stated for REST/WS (JWTs on the wire in clear), no token
expiry/refresh policy, TCP protocol is unauthenticated by design (IP
allow-list only — acceptable on an isolated management LAN, but say so as a
deployment requirement), no rate limiting on auth endpoints, no account
lockout. None of this is exotic; it should be a section, not an omission.

### R12. Audit/data lifecycle unspecified (§9)
`audit` is append-only with no retention, rotation, or size cap; LiteDB files
grow unbounded across years of operation. Also missing: config backup/restore
and LiteDB schema migration strategy across Airlock versions.

### R13. Fill conform target format is decided at upload time (§6)
The conform job scales to `WxH:N` — but a fill uploaded before any channel
locks format (or shared across channels with different formats) has no
defined target. Either conform-on-assign (per channel format) or require the
uploader to pick a target format, with re-conform supported.

### R14. `DUMP … clip?` is an unresolved placeholder in the state table (§4)
> **Decided 2026-07-07 (SCA):** yes — DUMP writes the flushed buffer as a
> compliance clip. Background `ClipWriter` (flush stays instant; slots recycle
> after the write), `clips/ch{n}/{timestamp}/` with manifest, retention via
> `ClipRetentionDays` (default 30). See AIR-14.
Whether DUMP writes the flushed buffer to disk (compliance clip) is left as a
literal `clip?` in the spec. This has storage, retention, and privacy
implications — needs a decision, not a comment.

## Minor

> **R15–R19 resolved 2026-07-07** — see docs/design/AIR-15-19-finishing.md.
> R15 was a real defect (placeholder XML didn't match the official NDI
> vancData schema — now pinned and fixed); R16 units confirmed; R19 rule
> implemented (per-channel debounce, DUMP always passes).

- **R15.** vancData XML schema is referenced but not pinned — capture the exact
  element/attribute schema from docs.ndi.video in an appendix so the encoder
  and the FAT recording sink test against the same normative text, and confirm
  the *downstream* encoder vendor actually consumes SCTE-104 from NDI VANC.
- **R16.** SCTE-104 field units (pre_roll_time, break_duration) should be
  cited to the exact table in ANSI/SCTE 104 in §7.2 — unit mistakes here are
  the classic interop bug and the template stores `preRollMs`.
- **R17.** Preview path: UYVY is not a SkiaSharp-native input; the
  UYVY→RGB conversion cost on PreviewWorker should be budgeted (per-server
  worker × N taps × 5 fps is fine, but say so).
- **R18.** No NTP/PTP requirement stated, yet audit timestamps and timecode
  verification depend on host clock sanity.
- **R19.** GPI debounce 50 ms + edge-trigger: specify behaviour for
  simultaneous edges (e.g. BUILD and DUMP in the same debounce window).
