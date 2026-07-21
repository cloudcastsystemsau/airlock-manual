# AIR-8 — Watchdog takeover sequencing & fail-back policy

Status: **RESOLVED 2026-07-07 — implemented** (`FailoverMonitor`, heartbeat
control header, watchdog process, `/api/server/failback`) · relates to
spec-review R8, §10, FR-52.

## Decisions

1. **Takeover only after kill-confirm.** Publishing pass-through senders under
   the channel NDI names while the main process is mid-crash risks two
   sources with one name on one host. `EngagePassThrough` contract: verify
   the main process is dead (PID/process check), force-kill if hung, wait for
   its sender sockets to close, *then* publish. FR-52's 5 s budget absorbs
   this comfortably (poll 250 ms + kill-confirm ≪ 5 s).
2. **Fail-back is operator-confirmed by default.** When main heartbeats
   resume, the relay keeps running (`AwaitingFailback`) — an automatic
   name-yield glitch mid-programming is worse than staying on pass-through.
   The operator confirms via `POST /api/server/failback` (audited) or
   `airlock-watchdog failback <path>`. `--auto-failback` restores the spec
   v0.2 automatic behaviour for plants that want it.
3. **No yield to a corpse.** If main dies again while awaiting confirmation,
   the monitor drops straight back to PassThrough; a stale operator ack is
   ignored while main is down.
4. **Restart coordination.** The heartbeat file carries a 16-byte control
   header: `watchdogState` + `failbackRequested`. The main process opens the
   existing file on restart (`CreateOrOpen`) so it sees PassThrough is active
   and **defers NDI sender creation** until the watchdog yields — closing the
   second race in the fail-back direction.

## Implementation

- `Airlock.Engine/FailoverMonitor` — pure state machine
  (Standby → PassThrough → AwaitingFailback), unit-tested including the
  die-again and stale-ack paths.
- `Airlock.Engine/Heartbeat` — control header (watchdog-owned state,
  control-plane-owned ack) ahead of the per-channel beat slots.
- `Airlock.Watchdog` — drives the monitor at 250 ms; `failback` subcommand.
- `Airlock.Control` — sim loop now beats the real heartbeat file per output
  frame; `/api/server/failback` (operator role, audited) + `/api/server/status`.
- NDI wiring points (`KillConfirmMain`, relay start/stop, deferred
  `send_create`) marked for the NDI milestone.

## Spec change request (for Cloudcast)

§10: add the kill-confirm precondition, the operator-confirmed fail-back
default (auto behind config), the shared-state header, and main's
deferred-sender-creation rule on restart.
