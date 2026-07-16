# AIR-40 — License enforcement via TreeksLicensingLibraryCore

Status: accepted (Dan, 2026-07-08). Pattern reviewed from ProfanityDelayService;
AIR-39 provides the package from the private GitHub Packages feed.

## Model

`LicenseService` (Airlock.Control) wraps the library behind `ITllClient` so the
process survives platforms where parts of the library can't run, and so the
service is unit-testable.

Boot: license loads from the OS store (registry), falling back to a
`licence.lic` file beside the executable (offline installs). The init chunk in `LicenseInitChunk.cs` is the **Airlock product chunk**
(ProductID 23, APIURL https://ccsystems.io) supplied by Cloudcast. On Linux the
library stores the activated licence as a file under `<app>/licence/` (the TLL
LinuxRegistry shim); on Windows it uses the registry key in the chunk.

### Expiry — three layers (as in ProfanityDelayService)

1. **Library-side**: signature + NTP-checked expiration on every verify, with
   the registry anti-rollback marker.
2. **App-side daily online re-check**: re-activation against
   `tllapi.cloudcastsystems.com.au` every 24 h. Server verdicts
   (revoked/expired/invalid) disable the unit **and stick** even though the
   locally cached license still verifies (`_serverVerdict` — this fixes a PDS
   bug where an unconditional `isValid = True` made the app-side check dead
   code). A successful re-activation clears the verdict.
3. **Local date check**: `UtcNow > ExpirationDate` refuses independently of
   the server.

### Offline allowance (and the removed grace period)

- **Offline allowance**: connection-failure results accumulate a persisted
  counter; the unit keeps running for 30 consecutive failed daily checks, with
  warning emails from day 24, then goes unlicensed (watermarked).
- ~~**No-license grace**: 30 days, persisted in LiteDB~~ — **REMOVED (Dan,
  2026-07-12)**: there is no grace period. No licence means unlicensed *now*:
  zero seats, so every delay channel and encoder runs watermarked (video
  burn-in + periodic audio tones, per the AIR-92 seat model) until a licence
  is activated. The `licenseState` doc keeps its legacy `Grace*`/`LastKnown*`
  fields (unused) so records sealed by earlier builds still verify; the HMAC
  seal now protects the offline counter and the AIR-108 backup window.

### Allowed features

`AllowedFeatures` strings, parsed by `LicenseGrant.Parse`:

- `CHANNELS=n` — operable delay channel cap (`COUNT=n` accepted as the
  ProfanityDelayService-era synonym). Absent → uncapped; demo → 1.
- Any other token is a named feature flag, e.g. `ENCODE` — checked via
  `LicenseService.HasFeature("ENCODE")` (ties into the Encode option design).
  The scheme is open-ended: new features are new strings, no code change
  needed to carry them.

### Enforcement points

- ~~BUILD refused at all three control surfaces when invalid or over the
  licensed count~~ — **AMENDED by AIR-92 (SCA, 2026-07-10)**: delay channels
  now use the encoder seat model instead of a hard BUILD block. Channels with
  `DelayLicenseAssigned` compete for the licence's per-kind channel counts,
  lowest ids first (`EffectiveSeats`); an **unseated channel still builds and
  runs but its output is watermarked** — the Airlock mark burned onto the NDI
  video output, and a ~1 s tone burst (random 400–1000 Hz, ≈ −12 dBFS, NAudio
  SignalGenerator) every 30 s on the audio (standalone delay output and the
  video's embedded audio). Seat changes and licence transitions flip the
  watermark live. `BUILD_REFUSED_LICENSE` is no longer emitted.
- **ROLLOUT and DUMP are never gated** — exits from delay must always work; a
  licensing fault must not trap content in the delay.
- **Unlicensed runtime limit (Dan, 2026-07-12)**: functionality with no output
  to watermark — data receivers (AIR-82) and scripts (AIR-57) — is time-boxed
  by `UnlicensedRuntimeLimiter` instead: 30 minutes per enable, then the item
  is disabled (persisted + audited `RECEIVER_UNLICENSED_TIMEOUT` /
  `SCRIPT_UNLICENSED_TIMEOUT`, sync-published, alert emailed). Any re-enable
  grants a fresh 30 minutes; a valid licence clears the clocks. Windows are
  in-memory (a restart is at least as disruptive as the timeout it dodges).
  Skipped on lockout backups — their config mirrors the master's limiter.
- Encoder seats (AIR-41) are unchanged: unlicensed encode carries the burnt-in
  text + mark watermark.
- Validity transitions are audited and emailed to the union of all alert
  groups via the AlertMailer worker (`SystemAlert`).

## Console

- Header pill (Licensed / attention / Unlicensed) and a banner with the
  specific warning; admins get a "Manage license" shortcut.
- Server ▸ License panel: status, masked serial, owner, expiry + days
  remaining, licensed channel count, feature flags, hardware ID
  (with copy — needed when requesting a license), last online check result,
  serial activation / trial activation / deactivation.

## Deviations from ProfanityDelayService (deliberate)

- Fixed: `DateTime.Compare` misused as a boolean; unconditional
  `isValid = True` after the expiry branch; brittle exact-string matching of
  server messages (now substring classification).
- No first-run grace at all (PDS relied on server-issued trials; Airlock's
  original 30-day grace was removed 2026-07-12) — an unlicensed unit runs
  watermarked rather than dark, so dev boxes and fresh installs still operate.
- Counter/window state lives in LiteDB with an HMAC seal instead of
  `PasswordHash.Encode` obfuscation.
