# Panel control — Stream Deck / Companion interface

> Epic AIR-152, tasks AIR-153..158 (+ AIR-159 named tokens). Merged via PRs
> #160–#163, #166–#168; token fleet management in the AIR-159 PR.

Hardware panels (Elgato Stream Deck on Windows/macOS, Bitfocus Companion)
control Airlock delay channels over a **dedicated TCP interface**, licensed by
the boolean **`PANEL`** licence flag. Airlock mints show-once, **named
connection tokens** (one per device/site); the plugin is configured with IP +
port + token. The port is a machine-local setting; the token collection
replicates to backups so panels survive a takeover.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Transport | Raw TCP, newline-delimited JSON on `SettingsDoc.PanelPort` (default 9351) | Trivial from Node (`net.Socket`) on both plugin platforms; follows the `TcpControlService` listener pattern; `HttpListener` WebSockets are Windows-only and a second Kestrel port entangles the HTTP pipeline |
| Unlicensed behaviour | **Status-only** — stream flows, every command refused `ERR_UNLICENSED` | Demos the display side, sells the control side |
| Token | **Named tokens** (AIR-159): `panelTokens` collection, one per device/site — `pt_` secrets shown once, `PasswordHasher` hashes only | ApiClientService pattern; the collection **replicates** to backups, port/enabled stay **local**; revoking (disable/delete) one token immediately disconnects that token's live sessions (`PanelTokenService.TokenRevoked` → `PanelControlService.KickToken`); a fleet re-keys one device, not all |
| Backup lock | Same split as TCP §8.2: `LockedFull` refuses all, `LockedExceptExits` keeps exits live | Never trap an on-air operator (AIR-92/107) |
| Rebind | Listener re-reads settings on every `ConfigChangeBus` settings publish and rebinds when port/enabled change | Operators expect a port change to apply without a service restart (improves on TcpControlService's read-once) |
| Plugins | One shared TS library (`integrations/panel-client`, zero deps) + thin Stream Deck / Companion adapters | Both platforms run Node; `catalog.ts` is the one action/field list every dropdown uses |

## Protocol (proto 1)

TCP, UTF-8, one JSON object per LF-terminated line. Unknown types → `error
ERR_PROTO` (connection stays open); unknown fields ignored. Server
implementation: `src/Airlock.Control/Panel/PanelProtocol.cs`; client mirror:
`integrations/panel-client/src/protocol.ts`.

### Client → server

```json
{"type":"auth","proto":1,"token":"pt_…","client":"streamdeck","clientVersion":"1.0.0"}
{"type":"subscribe"}
{"type":"command","id":42,"channelId":3,"action":"build"}
{"type":"ping"}
```

First message must be `auth` (10 s deadline, failure → `authResult ok:false
ERR_AUTH` + close + `PANEL_AUTH_FAILED` audit). `id` is a client correlation
integer echoed in `commandResult`. Session cap 16 (`ERR_BUSY`).

### Server → client

| Message | When | Shape |
|---|---|---|
| `hello` | on connect, pre-auth | `{proto, server, version, authRequired}` |
| `authResult` | reply to auth | `{ok, proto, panelLicensed, licenseValid, lockMode, serverName}` |
| `channels` | after subscribe + on change | `{channels:[{id,name,kind:"video"\|"audio",enabled}]}` |
| `status` | full on subscribe, then 250 ms deltas, full every 5 s | `{full, channels:[…]}` (below) |
| `serverState` | after subscribe + on change | `{lockMode, licenseValid, panelLicensed}` |
| `commandResult` | reply to command | `{id, ok, error?, message?}` |
| `pong` / `error` | keepalive / advisory | |

Delta frames carry only channels whose serialized status changed; merging is
idempotent (each entry is that channel's complete status).

Per-channel status:

```json
{"id":1,"kind":"video","state":"Live|Building|Delayed|RollingOut","depthFrames":250,
 "depthSeconds":10.0,"maxDelaySeconds":30,"censorActive":false,"postCensorActive":false,"alarms":[]}
{"id":5,"kind":"audio","state":"Idle|Building|InDelay|Exiting","depthMs":8000,"running":true,
 "alarm":false,"coughActive":false,"censorActive":false,"postCoughActive":false,"postCensorActive":false}
```

Video status reads the same runtime fields as TelemetryHub; audio is polled
from `AudioDelayService.Status` on the tick — one uniform push stream (audio
channels are not in `/ws/telemetry`).

### Actions

Video: `build rollout dump censor censorOn censorOff censorPostOn censorPostOff forceCensorOff`.
Audio (1:1 with `AudioCommandKind`): `build dump dumpAll exit exitCompress exitRollout
cough coughOn coughOff coughPostOn coughPostOff censor censorOn censorOff
censorPostOn censorPostOff forceCensorOff`.

Exits (live in `LockedExceptExits`): video `rollout dump`; audio `dump dumpAll
exit exitCompress exitRollout`.

Command gate order: authed → `PANEL` licence → lock mode → kind/action validity
→ the same seams as REST/TCP/GPIO (`ChannelCommandGate.Enqueue`,
`ChannelRuntime.EnqueueCensor`, `AudioDelayService.SendCommand`), source
`"panel"`, principal `"{client}@{peerIp}"`.

### Errors

`ERR_AUTH ERR_NOT_AUTHED ERR_UNLICENSED ERR_LOCKED ERR_INVALID_STATE
ERR_LICENSE ERR_NOT_RUNNING ERR_NO_CHANNEL ERR_BAD_ACTION ERR_PROTO ERR_BUSY`

## Server surface

- `Panel/PanelControlService.cs` — listener/rebind/tick/dispatch (`BackgroundService`).
- `Panel/PanelTokenService.cs` — named-token mint/verify/revoke (AIR-159);
  legacy single `PanelTokenHash` migrates to a "Default (migrated)" token doc
  on first use.
- REST: `GET/PUT /api/settings` (`panel {enabled, port}`; port validated
  1..65535 and ≠ `TcpPort`), `GET/POST /api/panel/tokens` +
  `POST .../{id}/enabled` + `DELETE .../{id}` (admin, show-once secrets),
  `GET /api/panel/status` (admin: licensed/listening/connections incl. which
  token each panel used).
- SPA: **Server → Panel control** (`web/Airlock.Web/src/panel.tsx`).
- Sync: `panelTokens` collection replicated (SyncCollections/SyncApplier);
  `PanelEnabled`/`PanelPort` local. A backup operator enables the backup's
  listener explicitly. (Backup-side kick-on-sync-apply is not wired — a
  revoked token's session on a backup survives until reconnect, where it is
  refused; backups are lock-refused anyway.)

## Plugins

- `integrations/panel-client` — shared client: reconnect w/ jittered backoff
  (auth failure stops retrying), ping 10 s / dead 25 s, channel+status caches,
  correlated `sendCommand` (5 s timeout), `catalog.ts` actions/fields +
  `isActionAvailable` (licence, lock split, state legality) for tile dimming.
- `integrations/streamdeck` — SDK plugin (Node 20 runtime), global settings
  host/port/token, two actions (command key with live face / status tile),
  whole-tile SVG rendering, vanilla-JS property inspectors (offline-safe),
  `streamdeck pack` → one `.streamDeckPlugin` for Windows+macOS.
- `integrations/companion` — Companion 3.x module (base 1.14, node18):
  channelCommand action (kind-filtered dropdowns), state/censor/cough/alarm/
  lock/licence feedbacks, per-channel variables, per-channel presets.
  Installed via Companion's developer-modules path; registry needs a public
  standalone repo (future work).
- `build/build-integrations.sh` builds all three (on demand, like build-web.sh).

## FAT checklist

Server (automated: `PanelProtocolTests`, `PanelTokenServiceTests`,
`PanelControlServiceTests` — 30 tests):

- [ ] Bad/missing/regenerated-away token → `ERR_AUTH`, connection closed, audit row.
- [ ] Unlicensed: subscribe streams status, every command `ERR_UNLICENSED`.
- [ ] LockedFull backup: all commands `ERR_LOCKED`; LockedExceptExits: exits pass.
- [ ] Video build from Live → accepted + audited (`source=panel`); rollout from Live → `ERR_INVALID_STATE`.
- [ ] Audio verbs on a stopped child → `ERR_NOT_RUNNING`; wrong-kind action → `ERR_BAD_ACTION`.
- [ ] Delta framing: only changed channels between full frames.
- [ ] Port change / disable in the SPA rebinds the listener without a restart.

Manual (needs a live server; CLI = `node integrations/panel-client/dist/examples/cli.js`):

- [ ] SPA: enable panel, save port, generate token (shown once), connected panels appear.
- [ ] CLI watch shows 4 Hz status for video + audio channels; commands round-trip.
- [ ] Companion emulator: presets appear per channel; dump/build fire; state feedback recolours; unplugging the server flips the instance to Disconnected and back.
- [ ] Stream Deck (hardware): global settings connect; channel dropdown fills; command key shows state colour + delay and fires; unlicensed shows STATUS ONLY.
- [ ] Backup instance: same token works after takeover (hash synced); tiles show LOCKED while synced.
- [ ] Licence portal: request `PANEL` on a test serial; flag appears in `GET /api/license` features and commands unlock.
