# AIR-86 — Data routes: receiver data through a delay channel

Status: accepted 2026-07-10 (SCA direction: receivers are pure inputs defined
once; a routing layer binds one receiver to one-or-many delay units, each route
with its own sends). Legacy references:
`ProfanityDelayService/Data/tcpDataClient.vb` (data ports: RX + send list,
re-send interval = live audio depth, dump flushes the pending window) and
`TimeZoneDelayService/Buffers/CommandList.vb` (timestamped queue + tick
release). Scheduling rules shared with `docs/design/gpio-delay-relay.md`.

## The problem

Programme-accompanying data (now-playing metadata, RDS text, automation cues)
leaves the studio in real time, but the programme leaves Airlock delayed.
Downstream consumers (RDS encoders, web now-playing, captioning) must receive
the data **in sync with the delayed output**, not the live event.

## Model

- **Receivers stay pure inputs** (AIR-82, unchanged). A new **route**
  (`DataRouteDoc`, LiteDB `dataRoutes`) binds `ReceiverId → ChannelId` with a
  sends list. One receiver may have any number of routes — to video and audio
  channels simultaneously; each route delays the same message independently by
  *its* channel's live depth and fans out to *its own* sends.
- `ChannelId = null` ⇒ real-time passthrough route (same code path, depth 0).
- A **send** is a persistent outbound TCP client (auto-reconnect with jittered
  capped backoff + optional init message per session — legacy `initMsg`), a
  UDP sender, or **an existing receiver** ("send back where it came from"):
  receive on A, delay, re-emit through A *and* on to B. A tcpServer receiver
  broadcasts to its connected clients, a tcpClient receiver writes to its peer
  (each applies its own framing's newline); udpServer targets are rejected —
  no peer to reply to. Deleting a receiver removes sends that pointed at it.
  Note: a downstream device that echoes what it receives back into the same
  receiver will loop — same property as the legacy data ports; don't do that.
  Per socket-send `AppendNewline` (default on) for line-oriented consumers,
  since lines-framed receivers strip the terminator.
- `PostOffsetMs` per route = legacy `postcensordelayoffset` fine-trim.

## Scheduling (mirrors gpio-delay-relay, SCA-confirmed rules)

Armed at message arrival with `due = now + CurrentDepthMs(channel) + PostOffsetMs`:

- video: `ChannelRuntime` depth (`Core.Depth / Fps`); audio: heartbeat
  `DepthMs` **+ `PostCensorOffsetMs`** when the post output is configured
  (downstream follows the post output).
- Live / Idle (or audio delay not running) → **fire immediately**.
- Building → **current live depth** (both build modes; known approximation:
  depth still grows while the entry waits — accepted, same as the relay rule).
- Delayed / InDelay → live depth.
- **RollingOut / Exiting → drop the message** (not queued, not passed —
  uniform with the relay rule; already-armed entries still fire unless dumped).

A 25 ms sweep timer releases due entries in arrival order. The queue is
**in-memory** (pending data does not survive a restart — legacy parity) and
bounded (10 000 entries, oldest evicted with a warning).

## Dump interplay

- **Video**: on the `Dumped` notification, `depthAfter` is read post-flush and
  the dumped span is sized from the notification's skipped input-frame range
  (`SkipFirst..SkipLast` × frame period). Entries with
  `due ∈ (now + depthAfter, now + depthBefore]` are cancelled — exactly the
  discarded content.
- **Audio**: on the `Dump` command (`AudioDelayService.CommandSent` seam),
  `depthBefore` = heartbeat `DepthMs` and the span = configured `DumpSizeMs`
  (0 ⇒ `DelaySizeMs`). *Approximation*: the child computes exact
  before/after depths (`AudioDelayNotification`) but they do not cross the
  heartbeat IPC; acceptable at data granularity. `DumpAll` cancels every
  pending entry for the channel.
- COUGH/censor/rebuild do not disturb queued entries (their content still airs).

## Surfaces

- REST `/api/data-routes` CRUD (viewer read, admin mutate, audited,
  `Reconcile()` after each change). Deleting a receiver cascades its routes.
- Console: **Routing** tab in Data Receivers — receiver → channel → sends with
  per-send connection state and queued/sent/dumped/dropped counters; releases
  appear in the shared live log as `tx` frames.
- Scripting: **`dataDelayed`** trigger kind — fires at release (air) time with
  `args = { receiver, source, data, channel }`, filterable by receiver name
  and channel. Complements `dataReceived` (fires at arrival time).

## Out of scope (v1)

- Persistence of pending entries across restarts.
- Serial I/O (absent from the legacy products too — their type enum is tcp|udp).
- Emitting delayed data as **NDI output metadata**: the engine machinery
  exists (`ChannelRuntime.InjectMetadata` → `MetadataQueue`/`MetadataReleaser`,
  frame-exact) but `NdiDelayEngine` neither stores nor emits metadata yet —
  revisit with the NDI wiring milestone.
- `air.SendData(...)` host API (deferred from AIR-82; `TrySend` seam in place).
