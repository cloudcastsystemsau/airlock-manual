# AIR-10..13 — Operational hardening

Status: **RESOLVED 2026-07-07** — AIR-10/11/12 implemented; AIR-13 design
decision recorded (implementation at the fill-pipeline milestone).

## AIR-10 — Memory admission control (R10)

Channel start is gated by `MemoryAdmission`: pool footprint (all-up-front
allocation, §3.2) must fit inside physical RAM minus a 25% reserve for
OS/control-plane/NDI buffers. A refused channel does **not** start — it
audits `ALARM_MEMORY_ADMISSION` with the exact byte figures — rather than
letting paging degrade every channel on the server. Container/cgroup-aware
via `GC.GetGCMemoryInfo()`. Reference sizing: a 64 GB server carries ~7×
30 s 1080p50 channels; 48 GB carries ~5–6.

## AIR-11 — Security posture (R11)

- Login rate limit: fixed window, 5 attempts/min/IP → 429 + audit
  (`LOGIN_RATE_LIMITED`); failed logins audited with username + peer IP.
- JWTs expire at 8 h (shift-length); no refresh tokens in v1 — re-login.
- **TLS is a deployment requirement, not application code**: terminate HTTPS
  at Kestrel (`Kestrel:Certificates` config) or a reverse proxy; the REST/WS
  listener must not face a routable network in clear. To be stated in the
  deployment guide.
- TCP control protocol remains unauthenticated **by design** (allow-list +
  management-NIC binding, NFR-07) — acceptable only on an isolated management
  LAN; that constraint is now explicit.
- Bootstrap credential (`admin`/`airlock-change-me`) must be rotated at
  commissioning; first-login force-change is a v1.1 item.

## AIR-12 — Audit & data lifecycle (R12)

- Retention: `AuditRetentionService` sweeps entries older than
  `settings.AuditRetentionDays` (default 400) at startup and 6-hourly.
  `AuditService.Prune` is the **only** deletion path — the API surface stays
  append-only; retention is system policy, not an operator verb.
- Config backup: `GET /api/server/backup` (admin, audited) returns a
  checkpointed copy of the LiteDB file.
- Schema migration: LiteDB's BSON mapper tolerates added fields with
  defaults; destructive shape changes require an explicit migration step in
  the installer, versioned via a `schemaVersion` settings field (introduce on
  first breaking change).

## AIR-13 — Fill conform target format (R13)

**Decision: conform-on-assign.** Upload stores the mezzanine file only (no
conform at upload — the target format is unknowable then, which was the R13
defect). Assignment to a channel triggers a conform job to that channel's
locked format; the conformed artefact is cached per `(fillId, formatHash)` so
re-assignment and multi-channel reuse are free; a channel format change
invalidates and re-conforms. Assignment completes (fill becomes active) only
when the conform job for the matching hash reports ready + hash-verified
(FR-22). Implementation lands with the fill pipeline milestone (ffmpeg
invocation per §6); the reject path for a missing/mismatched conform is
already in place via `FillAssignResult`.
