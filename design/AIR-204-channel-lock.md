# AIR-204/205 — Channel lock/follow (lock delay units to each other)

> AIR-204 (server core + all control surfaces), AIR-205 (SPA settings +
> locked-controls UI).

A delay channel (video or audio) can be **locked to a leader** delay channel
(either kind). While locked, the follower refuses every operator control
surface and instead **mirrors the leader's transport commands**. The lock
changes *control only*: logging/audit, alarms, silence detection, schedules,
data-route pass-through (delayed data keeps flowing through a locked channel)
and master/backup sync all behave exactly as before.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Config | `ChannelDoc.LockToChannelId` (int?, both kinds) | One collection, one id space; replicates with `channels`; in `SyncApplier.LiveApplyFields` + `SetLockedTo`/`LocksChanged` hooks (policy-only — never restarts a runtime) |
| Chains | Refused at save (leader may not be a follower; a channel with followers may not become one) | Mirror fan-out can never recurse; no cycle detection needed at dispatch time |
| Blocking | Per surface, like the AIR-107 backup lockout: gate outcome `Locked` (REST/panel/script/SNMP), explicit checks in legacy TCP + GPIO + the REST censor/audio endpoints, and a fail-closed backstop inside `AudioDelayService.SendCommand` (`source != "lock"`) | Control enters through six surfaces and only REST passes middleware; GPIO previously reached `Core.Enqueue` unchecked |
| Blocked verbs | Transport only: build/rollout/dump/trigger, censor verbs, all audio commands | Config stays open — that is how a follower is unlocked; freeze/fill/SCTE-block are config/incident controls, not transport |
| Mirroring | At the leader's *execution* seams, not its surfaces: `ChannelManager.RuntimeNotification` (EnteredBuilding→Build, EnteredRollingOut→Rollout/ExitRollout, Dumped→Dump), `ChannelManager.CensorEnqueued` (censor verbs 1:1), `AudioDelayService.CommandSent` (verb-level) | Followers track the leader no matter what drove it (operator, script, GPIO, schedule); manager-level events are wired in `StartRuntime` so they survive runtime restarts and runtime-created channels |
| Mirror dispatch | `ChannelLockService` with delegate-injected `EnqueueVideo` (via the gate — audits + re-evaluates state legality per follower), `EnqueueVideoCensor`, `SendAudio`; source `"lock"`, principal `ch<leader>` | ChannelCommandGate idiom: unit-testable, no service-construction cycles |
| Cross-kind verb map | build↔build, video rollout↔audio exit-rollout, dump↔dump (audio DumpAll→video Dump), censor verbs 1:1; audio cough has **no video equivalent** (skipped) | Match the closest legacy behaviour per kind |
| Depth divergence | Warned in the SPA (amber, non-blocking) when configured lengths differ (video `TargetDelaySeconds` vs audio `DelaySizeMs`; delay-to-asset can't be compared) | The lock mirrors commands only — depths will not converge on their own, by design |
| Surfacing | `lockedToChannelId` in `GET /api/channels`, `GET /api/audio-channels`, and the panel status stream; refusals audit `CMD_REFUSED_LOCKED` / `AUDIO_CMD_REFUSED_LOCKED`; REST 403 `ERR_LOCKED`, TCP `ERR … LOCKED`, panel `ERR_LOCKED` | Same shapes as the backup lockout so panels/UI dim consistently |
| Delete | Deleting a leader clears its followers' locks (referential cleanup beside mappings/schedules/routes) | No dangling references |

## Surfaces × enforcement

| Surface | Block | How refused |
|---|---|---|
| REST build/rollout/dump/trigger | gate `Outcome.Locked` | 403 `ERR_LOCKED` |
| REST censor, REST audio action | endpoint pre-check | 403 `ERR_LOCKED` |
| Legacy TCP (all transport verbs) | `Execute` pre-check | `ERR <ch> LOCKED channel locked to channel N` |
| Panel (Stream Deck/Companion) | `ExecuteCommand` pre-check | `commandResult ERR_LOCKED` |
| GPIO video command/censor edges | `GpioService` handler check | swallowed + audited |
| GPIO/any audio path | `SendCommand` backstop | `false` (+ audit) |
| Scripts (`air.Build`… / `air.AudioBuild`…) | gate / backstop | returns false |
| SNMP channelCommand SET | `DispatchCommand` pre-check | `AuthorizationError` |

## Redundancy interplay

The field replicates with the `channels` collection; a lock change alone is a
live-apply (no runtime restart) and rebuilds the backup's follower map via
`SyncApplierHooks.LocksChanged`. On a synced backup both locks compose: the
backup lockout refuses operators, while leader mirroring keeps running (the
backup's leader is driven by sync/GPIO the same as the primary's).

## REST

`POST /api/channels/{n}/lock-to` `{channelId: int|null}` (admin). Validation:
target exists, not self, target not itself locked, `n` has no followers.
Audits `CHANNEL_LOCK_TO`/`CHANNEL_UNLOCK`, publishes `channels`.

## Tests

`ChannelLockTests` — follower-map reload, gate refusal per source (+ mirror
source passes), video event mirroring to both kinds, audio→video verb map
(cough skipped), censor 1:1 map, audio-to-audio pass-through, `SendCommand`
backstop (refusal audited, `"lock"` source passes).
