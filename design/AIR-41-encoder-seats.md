# AIR-41 — Seat-based encoder licensing + Encoders UI + output preview

Status: complete + unit/live-verified (seat-drop live-verifiable only with a
real ENCODE=n licence — covered by unit tests here). Builds on AIR-38's
watermark and AIR-40's licence model.

## Licence model

The ENCODE entitlement is now a **count**, parsed by `LicenseGrant.Parse`
from `AllowedFeatures`:

- `ENCODE=n` → n encoder seats (and the `ENCODE` flag).
- bare `ENCODE` → unlimited seats.
- absent / demo → 0 seats.

`LicenseService.LicensedEncoders` exposes it (0 when unlicensed/grace); the
last-known count is persisted (HMAC-sealed) so a previously-licensed unit
keeps its seats through the grace window. Licence status carries `encoders`.

## Seats

`ChannelDoc.EncodeLicenseAssigned` marks a channel as holding a seat. The
**effective** seat holders are computed by the pure, unit-tested
`EncodeService.EffectiveSeats(assignedIds, seats)` — lowest channel id first,
up to the licensed count — so a licence downgrade automatically re-watermarks
the highest-id excess with no manual un-assignment. `Watermark(channelId)` is
now per-channel: empty only when the channel is in the effective seat set.

- `POST /api/channels/{n}/encode/license {assigned}` — assign/release; refuses
  assigning past the seat count; restarts the running child so the burn-in
  drops or appears.
- `GET /api/encoders` — `{ seatsTotal, seatsUsed, encoders[] }` for the UI.

## Encoder-output preview (real)

The encode child tees the **watermarked raw video** (after the overlay,
before the encoder) → `videorate 2/1` → `videoscale` (aspect-preserving 320-wide)
→ `jpegenc` → `multifilesink max-files=1` at `encode/ch{n}.preview.jpg`.
`GET /api/channels/{n}/encode/preview` serves the latest JPEG (JWT query-token
auth, like clips/fills); the console `<img>` polls it ~2 fps. This shows the
**actual encoded feed with the real burnt-in watermark**, not a simulation.

## Console

The ops view is split into a **Delay** section (the existing channel cards)
and a new **Encoders** section: one card per enabled encoder with the live
output preview (watermark visible), loudness/A-V/drops/SCTE status, a licensed
seat indicator, an **Assign / Release seat** control (disabled when the pool is
full), and **Configure** (the AIR-38 encode modal). The section header shows
`used / total licence seats`. The licence panel gained an "Encoder seats" line.

## Verified

- 270/270 tests (10 new: `ENCODE=n` parsing, bare-ENCODE unlimited, demo/absent
  zero, `EffectiveSeats` lowest-id-first / downgrade / unlimited); FAT PASS.
- **Live** (grace = unlicensed): encoder runs watermarked, `/api/encoders`
  reports `0/0` seats + `watermarked:true`, seat assignment is refused with a
  clear message, and the **preview endpoint serves a JPEG with the watermark
  visibly burnt in** (red pixels detected in the served 320×180 frame).
- Seat assignment dropping the watermark can only be exercised end-to-end with
  a real `ENCODE=n` licence (not mintable in this sandbox); the seat policy and
  count parsing are unit-covered, and the child restart-on-licence-flip path is
  the same one verified for AIR-38.
