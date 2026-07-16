# AIR-106 — Primary/backup redundancy (config sync, control lockout, 14-day licence window)

Status: **implemented 2026-07-11** (epic AIR-106, tasks AIR-107..113; PRs #102–#107+) ·
plan agreed with Dan 2026-07-11 · relates to AIR-8 (watchdog — same-host failover,
orthogonal), AIR-40/92 (licence enforcement / never-trap), spec-review R12.

## Problem

Customers want a warm/hot spare Airlock. A second instance must mirror the
primary's entire configuration continuously, must not fight the primary while
mirroring (control, NDI names, emails, GPOs, data sends), must become usable
the moment the primary is gone, and must not become a licence loophole — a
backup that never reconnects cannot remain a free, fully controllable Airlock
forever.

## Model

- **Roles** (`RedundancyDoc`, local-only `redundancy` collection — never synced):
  `standalone` (default, nothing changes) · `primary` (serves children; licence
  flag `PRIMARY`) · `backup` (dials a master; licence flag `BACKUP`). Role flags
  ride the AIR-40 `AllowedFeatures` scheme — no parser change; `BACKUPS=n`
  (child-count cap) is reserved, unimplemented.
- **Transport**: the backup dials `ws(s)://master:port/ws/sync` on the existing
  HTTP listener. Auth = shared 32-byte sync key (generated on the primary,
  pasted into backups; constant-time compare; `SYNC_AUTH_FAILED` audited) —
  deliberately not user JWTs, since user accounts are themselves synced data.
- **Replication**: full snapshot on every connect; after that, whole-collection
  pushes debounced 250 ms, driven by `ConfigChangeBus` (`bus.Publish` sits
  beside every mutating endpoint's `audit.Write`). No oplog: collections are
  tiny, and "master wins after divergence" falls out of snapshot-on-connect.
  `SyncSnapshot.SchemaVersion` gates the handshake — mismatched peers get a
  loud refuse, never silent field-dropping.
- **Scope**: all config collections + users (credentials included — master
  logins work on the backup; no shadow admin) + fill/audio-fill media
  (`MediaSyncService`: manifest with sha256, fetch-if-changed, prune; files
  land before the docs that reference them). Never synced: audit, clips,
  licence state, redundancy/syncState, and the machine-local `SettingsDoc`
  fields (`SettingsSyncMask` — a reflection test forces every new field to be
  classified).
- **Apply** (`SyncApplier`): serialized, ordered (referenced-before-referencing,
  channels last), full replace + the endpoints' own reconciles. Channel docs
  get typed handling — unchanged untouched; name/alert-group/audio-processing
  diffs live-apply; engine-affecting diffs restart just that runtime; audio
  channels drive their supervised child; encode follows `EncodeEnabled`.
- **Lockout**: while a backup is synced, *everything* mutating is refused —
  config and operational commands (REST 403 via `ControlLockoutMiddleware`,
  fail-closed for future endpoints; TCP verbs answer `ERR … LOCKED`). Its
  output is not on air; local commands would only diverge the mirrored delay
  state. Scripts/GPIO/schedules keep running (shared external triggers are
  what keep the hot backup's delay tracking the primary), but outward
  emitters are suppressed (`SuppressExternalOutputs`): alert emails, LWRP GPO
  drives (swallowed-as-sent; `Converge()` re-asserts on unlock), data-route
  sends. Allow-list: auth, licence, the redundancy panel itself, `/api/sync`.
- **14-day window** (AIR-108): on lost contact the licence service stamps a
  sealed `MasterLossUtc/BackupGraceEndUtc` (HMAC over the AIR-40 state doc,
  hardware-bound; the previous seal is a one-time legacy check). Controls
  unlock while it runs; reconnect resets it; expiry re-locks — but DUMP/
  ROLLOUT/`/api/server/failback` stay live (AIR-92: never trap an on-air
  operator). Clock-setback hardened: comparisons use `max(now,
  MaxClockSeenUtc)` and the daily tick advances the high-water mark ≥24 h of
  monotonic process time, so winding the clock back can neither extend nor
  freeze the countdown. Seal tamper fails **closed** (expired ⇒ locked);
  recovery = reconnect or role change. Orthogonal to the 30-day licence grace
  and offline-failure allowance.
- **NDI names** (AIR-112): a hot backup's outputs run suffixed (`"Airlock PGM
  (Backup)"`, suffix configurable). Losing the master unlocks controls but
  never renames — an unreachable master isn't necessarily dead, and duplicate
  sender names are worse than stale ones. **Takeover** is operator-confirmed
  (409 while the master is reachable): runtimes restart under primary names
  (`NamesAdopted` persists across reboots). Reconnect does *not* auto-relock a
  taken-over backup; applies pause until the operator **rejoins** (re-suffix,
  relock, full resync — master wins). Audio delay children have no NDI names.
- **UI** (AIR-113): Server ▸ Redundancy panel (role radios gated by licence
  flags, master address + write-only sync key, grace countdown, child
  registry, takeover/rejoin with confirms). Telemetry header bits 4/5 carry
  `controlsLocked`/`redundancyWarning`; banner text from `/api/server/status`
  (`redundancyWarning`, separate from `licenseWarning`). While fully locked
  the console disables operational controls; in the grace-expired state they
  stay clickable and the middleware (the authority) refuses non-exits with an
  explanatory error.

## Decisions of record

- Hot backup with renamed outputs (not warm/idle); name adoption manual.
- Grace expiry re-locks without watermarking (the unit may be legitimately
  idle; watermarking is a licence-validity concept, not a lock concept).
- Backup keeps its own seat counts (`CHANNELS=n` etc.) — role flags don't
  alter capability maths.
- Whole-collection replication, not an oplog; DB-file replace rejected
  (machine-local collections + every service holds the LiteDB singleton).
- Users replicate in full; the grace unlock is the break-glass.
- Script-internal var writes and per-login `LastLogin` touches deliberately
  do not publish (sync-storm avoidance); they ride snapshots.

## Working agreement (also in CLAUDE.md)

Every new mutating endpoint publishes its collections; every new collection is
classified replicated/local; every new `SettingsDoc` field goes into
`SettingsSyncMask` (build fails otherwise); new control surfaces consult
`RedundancyService.LockMode`; new outward emitters respect
`SuppressExternalOutputs`.

## Spec change request (for Cloudcast)

- New licence tokens: `PRIMARY` (may serve backup children) and `BACKUP`
  (may be configured as a backup; 14-day disconnected local-control window).
  Reserved: `BACKUPS=n`. Tokens are plain `AllowedFeatures` strings — no
  licence-server changes needed beyond issuing them.
- Spec §redundancy: document the master/backup topology, the sync key
  exchange, the lockout semantics, and the 14-day rule as normative
  behaviour. Real PRIMARY/BACKUP licences are not mintable in the dev
  sandbox — tests use the FakeTll seam.

## Verification

`tests/Airlock.Tests`: RedundancyTests (state machine + middleware),
BackupGraceTests (window/clock/tamper), SyncApplierTests (replication
semantics), SyncTransportTests (real-Kestrel end-to-end incl. media),
MediaSyncTests, ChannelManagerRedundancyTests (suffix/takeover on ENGINE-SIM
runtimes). Two-instance manual drill: run two instances with distinct
`--urls`/`--Db:Path`, Primary + key on one, Backup on the other; see the
AIR-113 PR description for the scripted walk-through.
