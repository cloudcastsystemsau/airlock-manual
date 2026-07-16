# AIR-134 — Alarm email notifications (active/restored) + audio silence detection

Status: **implemented 2026-07-12** (AIR-134) · relates to AIR-23 (DUMP alert
groups / AlertMailer), AIR-52 (audio delay supervisor), AIR-69/122 (audio
monitor tap — the silence meter source), AIR-106..113 (sync + backup email
suppression), AIR-42 (telemetry alarm bits).

## Problem

Alarms (video source loss, encoder down, audio delay down…) were UI/GPO/
telemetry-only — nothing emailed anyone, several video alarms latched forever
(so "restored" didn't exist), video/encode transitions weren't audited, and
there was no true broadcast silence detector (a live card carrying silence
raised nothing). Operators want alarm active AND restored emails routed to the
existing alert groups.

## Model

- **AlarmCatalog** (`AlarmCatalog.cs`): single source of truth `code →
  {category, friendly name, severity, momentary?, autoClearSeconds}`.
  Categories: `videoDelay | encoding | audioDelay | system`. Momentary codes
  (`FIFO_OVERFLOW`, `SCTE_IN_SKIP`, `METADATA_QUEUE`) auto-clear 30 s after
  their last recurrence; fatal codes clear on runtime rebuild (already true);
  the rest raise/clear naturally. `ALARM_SCTE_ABSOLUTE` stays reserved
  (telemetry bit parity, no raise site).
- **Lifecycle tidy**: `ChannelRuntime.RaiseAlarm/ClearAlarm` audit
  `ALARM_RAISED`/`ALARM_CLEARED` on actual transitions only (repeat raises just
  refresh the momentary window). The audio supervisor's audits moved to the
  same vocabulary (was action=`ALARM_AUDIO_DOWN` + state field).
  `SweepMomentaryAlarms` runs from the notifier loop, never on engine threads.
- **Two-level assignment**: an `AlertGroupDoc` gains `AlarmCategories` +
  `NotifyActive`/`NotifyRestored` (what it wants); a `ChannelDoc` gains
  `AlarmAlertGroupIds` (who hears about this channel), deliberately separate
  from the DUMP `AlertGroupIds`. A group is emailed iff it subscribes to the
  alarm's category AND (channel-scoped: it is assigned to that channel;
  server-scoped `Channel 0`: no assignment check). No assignment ⇒ no emails
  (DUMP semantics). Defaults keep every pre-existing group DUMP-only.
- **AlarmNotifier** (BackgroundService, 1 Hz poll): snapshots the three alarm
  stores (video runtime lists incl. encode piggyback; audio child down +
  silence), sweeps momentary alarms, and drives a pure per-(channel, code)
  **AlarmDebouncer**: ACTIVE email after `ActiveHoldoffSeconds` (default 15 —
  above the supervisors' ~3 s startup heartbeat grace so boots stay quiet),
  RESTORED after `RestoredStableSeconds` (30) of continuous clear and only if
  an ACTIVE was sent, `CooldownSeconds` (300) flap guard that defers (not
  drops) a persistent re-occurrence. Settings live in
  `SettingsDoc.AlarmEmail` (synced), re-read every tick. Polling (not raise/
  clear callbacks) was chosen because raises happen on engine receive threads,
  the sim loop and two supervisors — and the debounce windows make sub-second
  latency worthless.
- **Emails**: `AlertMailer` gains `AlarmAlert` + `QueueAlarmAlert` +
  pure `BuildAlarmEmail` (subject `[Airlock] ALARM ACTIVE: Source lost —
  Channel 1 (CH 1)` / `RESTORED: …` with outage duration) + pure
  `ResolveAlarmRecipients` implementing the two-level rule. Recipients resolve
  at send time, so group edits made while an alarm is pending are honoured.
  Backup suppression is inherited (`AlertMailer.Suppress` ←
  `SuppressExternalOutputs`); the backup's notifier runs and audits locally but
  never sends.
- **Silence detection** (`ALARM_AUDIO_SILENCE`): Control-side, per audio
  channel, fed inline from `AudioDelayService.MonitorLoopAsync.Pump`'s already-
  computed input-lane peaks (~20 ms cadence; the AudioMeter itself is not read
  — `Read()/Snapshot()` reset peak-hold for their existing consumers).
  `AudioSilenceDetector`: silent = peak below `SilenceThresholdDbFs` (-50)
  continuously for `SilenceHoldSeconds` (30); restored = peak above threshold +
  `SilenceHysteresisDb` (6) for `SilenceRestoreSeconds` (5); suppressed (and
  force-cleared) while the child is unhealthy — `ALARM_AUDIO_DOWN` owns that.
  Config rides `AudioDelaySettings` (existing endpoint/validation/UI/sync) and
  is deliberately absent from `RestartReasons` ⇒ hot-applies; the child never
  reads the fields.
- **Telemetry**: `ALARM_NDI_ENGINE` (bit 8) and `ALARM_MEMORY_ADMISSION`
  (bit 9) joined the `alarmBits` table (u16 had room; unknown bits are
  forward-safe). Audio codes stay REST-polled — audio channels have no
  telemetry channel record.
- **Video silence detection** (`ALARM_VIDEO_SILENCE`, AIR-135): the same
  detector on video (NDI) channels' input audio. Per-channel
  `ChannelDoc.SilenceDetect` (threshold/hold/hysteresis/restore, same ranges),
  volatile-swapped so `PUT /api/channels/{n}/silence-detect` live-applies (and
  the field is in `SyncApplier.LiveApplyFields` — no backup runtime restarts).
  Fed at the engine's input-meter site (`NdiDelayEngine.MeterFrom` → max peak,
  alloc-free on the engine thread) and from the sim tone push (constant
  −18 dBFS, never alarms). A source that keeps sending video but drops its
  audio stream counts as silent: the `AlarmNotifier` tick calls
  `PumpSilenceStall`, which feeds peak 0 once no audio frame has arrived for
  >2 s. Suppressed (and force-cleared) while `ALARM_SOURCE_LOST` is active — a
  fully dead feed is source-lost, never both. Config UI: an Alarms tab in the
  video channel settings modal (which also hosts the alarm alert-group
  assignment, moved from the source tab). Not in the telemetry bit table
  (REST `alarms` array carries it).
- **Alarms page** (AIR-136): `AlarmSnapshotProvider` is the single source for
  "active right now" — flattens the video runtime lists (with per-code
  `SinceUtc` stamps kept under the alarm lock) and the audio children's
  down/silence stamps, enriched from the catalog. `GET /api/alarms` serves it;
  `GET /api/alarms/history` pages the `ALARM_RAISED`/`ALARM_CLEARED` audit rows
  (new `Action` index on the audit collection; the uniform vocabulary from
  phase 1 is what makes history a pure audit query). Console: a viewer-visible
  top-level Alarms page (`alarms.tsx`) — active table with live durations +
  paged history, 3 s polling. The provider is deliberately shared with the
  AIR-138 SNMP agent so external surfaces can never disagree with the console.
- **Webhooks** (AIR-137): a group is a notification *target* — emails, a
  webhook, or both. `AlertGroupDoc.WebhookUrl` + write-only `WebhookSecret`
  (GET exposes `hasWebhookSecret`; empty PUT keeps; clearing the URL wipes the
  secret). Delivery rides the same `ResolveAlarmGroups` predicate as email —
  category subscription × active/restored flags × channel assignment — and the
  same queue/Suppress gate, so backups never double-fire. The SMTP-unconfigured
  guard moved into the email branches: webhooks fire without SMTP. Payload =
  one JSON object (event/active/code/friendlyName/category/severity/channel/
  channelName/whenUtc/activeDurationSeconds/instance); when a secret is set the
  body is signed `X-Airlock-Signature: sha256=HMAC-SHA256(body, secret)`. One
  attempt per URL, 10 s timeout, per-URL isolation, sent after emails;
  `WEBHOOK_SENT`/`WEBHOOK_FAILED` audited. Test-fire:
  `POST /api/alert-groups/{id}/webhook-test`. Deliberately not retried and not
  extended to DUMP/system alerts (flagged in the ticket).
- **SNMP agent** (AIR-138): v2c, `Lextm.SharpSnmpLib`, UDP listener with a pure
  PDU handler (unit-tested without sockets; one real-UDP round-trip test).
  Tree under `1.3.6.1.4.1.99999.134` (no registered PEN — documented constant;
  `docs/airlock.mib`): server scalars (alarm counts, worst severity,
  redundancy role, licence, watchdog) + a channel table sourced from
  `AlarmSnapshotProvider` and the existing status paths, so SNMP can never
  disagree with the console. `airlockChannelCommand` SET mirrors the GPIO verb
  set and routes through the same paths (`ChannelCommandGate` for
  build/dump/exit, video censor queue, audio control block), audited source
  `snmp`; SETs need a separate non-empty write community and are refused with
  authorizationError while `RedundancyService.ControlsLocked` (reads still
  answer — polling local state is not a plant output). `SettingsDoc.Snmp` is
  machine-local (`SettingsSyncMask.LocalFields`); settings hot-apply on a 5 s
  re-check. Linux: port 161 needs CAP_NET_BIND_SERVICE — bind failure audits
  `SNMP_BIND_FAILED` once and the log names the fix. No traps/informs, no v3
  (flagged in the ticket).

## Decisions / edges

- **Startup memory-admission refusals** (channel refused before any runtime
  exists) stay audit-only — the notifier can't see a store that isn't there.
  Revisit if a server-scoped alarm list ever materialises.
- **`serverAlarm` GPO** still ignores audio alarms (pre-existing); extending it
  changes plant behaviour — left for an explicit ask.
- **Restart amnesia is accepted**: the debouncer starts empty, so an alarm
  already active at boot emails ACTIVE once after the holdoff (arguably
  desirable), and an ACTIVE emailed before a restart never gets its RESTORED.
- Channel disable/delete drops its alarms from the active set → a pending
  episode resolves as RESTORED after the stable window. Honest enough.

## Files

`AlarmCatalog.cs`, `AlarmNotifier.cs` (+`AlarmDebouncer`),
`AudioSilenceDetector.cs`, `AlertMailer.cs`, `ChannelManager.cs`,
`AudioDelayService.cs`, `AudioDelaySettings.cs` (Engine), `Models.cs`,
`SettingsSyncMask.cs`, `SyncApplier.cs`, `TelemetryProtocol.cs`, `Program.cs`;
SPA: `api.ts`, `App.tsx` (group editor + channel section), `audio.tsx`
(Alarms tab + SILENCE badge), `settings.tsx`, `telemetry.ts`. Tests:
`AlarmNotifierTests`, `AlarmLifecycleTests`, `AudioSilenceDetectorTests`,
`AlertMailerTests`.
