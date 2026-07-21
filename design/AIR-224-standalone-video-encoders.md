# AIR-224 — Standalone video encoders

Video encoders (the AIR-34/35 SRT/UDP contribution branch) stop being a
per-channel field and become standalone entities — the AudioEncoderDoc (AIR-165)
model: an own collection with ids/names/enable/seats, `sourceKind
channel|ndi` where a delay channel is just one possible source, and several
encoders may source the same channel.

## Decisions

**D1 — VideoEncoderDoc, migrated once.** `videoEncoders` LiteDB collection
(replicated; applied AFTER `channels` in the sync order so a source channel
exists before its encoder starts). `EncodeConfig` gains `SourceChannel`.
`ChannelDoc.EncodeEnabled/EncodeLicenseAssigned/Encode` are dead fields kept
for the one-time migration (`Db.MigrateVideoEncoders`, guarded by the
machine-local `SettingsDoc.VideoEncodersMigrated`): each channel with encode
state becomes one encoder named "*channel* encoder" in ascending channel-id
order, so the AIR-41 lowest-id-first seating keeps the same set seated.

**D2 — taps are keyed by encoder, N per channel.** `EncodeRing` carries
single-consumer heartbeat fields, so encoders cannot share one ring; instead
`ChannelRuntime` holds a dictionary of `EncodeTap`s keyed by encoder id plus
an immutable snapshot array the frame paths iterate (one volatile read per
frame, NFR-04). The engine's `SetEncodeTap` became `SetEncodeTaps(EncodeTap[])`;
every write site (as-aired frame, SCTE 104→35 conversion, originated
triggers) loops the array. **The snapshot is re-applied on every engine
rebind** (`StartDelayEngine`), fixing the pre-existing orphan: a same-format
source swap used to leave the tap on the disposed engine, silently freezing
the encoder feed.

**D3 — supervisor watches, not hooks.** `EncodeService` children are keyed by
encoder id (`encode/enc{id}.*`). The 500 ms supervision tick additionally
watches: seat watermark flips (as before), **suppression flips** (D4), the
source channel's **runtime identity** (`rt.HasEncodeTap(encoderId)` false ⇒
the runtime was rebuilt or appeared — reconfigure to attach a fresh ring+tap),
and the source format (AIR-90). A missing source channel at Enable is not an
error: the child runs against a standalone ring and the watch attaches when
the runtime appears.

**D4 — output suppression (the gap).** Video encoders previously had NO
redundancy suppression — a locked backup double-fed the plant. Now
`EncodeConfig.SuppressOutputs` (service-written, the AudioEncoder pattern) is
stamped at child start; a suppressed child builds its pipeline into a
`fakesink` — no SRT listener port, no UDP datagrams — and a role flip
reconfigures (sink is baked into the pipeline, like the watermark burn-in).

**D5 — encoder-scoped alarms and events.** `ALARM_ENCODE_DOWN`/`ALARM_AV_OFFSET`
moved off the channel runtime onto the service (the AENCODE
`ActiveAlarms()` tuple surface; AlarmNotifier/Snapshot render channel-0 rows
with the encoder's name). The `encoderEvent` script trigger now delivers the
**encoder id** (breaking — agreed). Audit rows are server-scoped (channel 0)
with the encoder id in the detail.

**D6 — per-channel wire shapes become aggregates.** Telemetry chFlags bits
0-3 and SNMP columns 10/11 predate standalone encoders; they now aggregate
over the encoders sourcing the channel (enabled = any; running = all running;
watermarked/seated = any), detail stats from the lowest-id one. The SPA cards
poll per-encoder status instead of channel telemetry. `ALARM_ENCODE_DOUBLE_PROC`
(AIR-207) stays channel-scoped, computed against the encoder set.

**D7 — REST clean break (agreed).** `/api/video-encoders` CRUD mirrors
`/api/audio-encoders` (create/enable/license/config/audio-processing/preview);
the channel-scoped `/api/channels/{n}/encode*` endpoints are removed, and the
channel card lost its Encode pill. SPA: `videoencoders.tsx` (the
audioencoders.tsx shape); dashboard tiles re-keyed.

## Verified (real NDI engine)

Two encoders (UDP + SRT) sourcing one channel simultaneously; ffprobe of the
UDP TS shows h264 + AAC + SCTE-35; a same-format source rebind left both taps
flowing (the D2 fix); kill -9 of a child raised/cleared the encoder-scoped
ALARM_ENCODE_DOWN with an automatic restart (FR-87); preview JPEGs serve via
the query-token path.
