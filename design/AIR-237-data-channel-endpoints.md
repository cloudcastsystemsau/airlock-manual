# AIR-237..241 — Data-channel endpoints (encoder inputs, decoder outputs)

Status: accepted · 2026-07-17

## Problem

The audio RTP transport carries a data side-channel (AIR-191..193): a second RTP
stream on media-port+6 that multiplexes GPIO events and opaque data messages
(kind 3, slot 0..255, ≤200 bytes/message), 3×-re-carried against loss and
released playout-aligned at the far end. But getting arbitrary data **into** the
channel requires a data receiver + a data route with an `rtpData` send, and
getting it **out** requires scripting or routes off the virtual `rtpDecoder`
receiver. Operators expect the iPort shape: configure a listener on the encoder,
an output on the decoder, done.

## Design

**Per-entity data-channel endpoints**, configured on the encoder/decoder doc and
run by `DataChannelEndpointService` in the parent process:

- **Inputs** (encoder): `DataChannelInputDoc { slot, kind: tcpServer|udpServer,
  port, framing: raw|lines, enabled }`. Received messages are injected into the
  encoder's carried channel via the existing `AudioEncodeService.SendData`
  (ADTA control ring → child stamps the current audio timestamp). Messages over
  the wire cap (200 B) are dropped and counted, never truncated.
- **Outputs** (decoder): `DataChannelOutputDoc { slot (-1 = all), kind:
  udpEndpoint|tcpClient|tcpServer, host, port, appendNewline, enabled }`. Every
  playout-released kind-3 message fans out to all matching outputs: one datagram
  per message (`UdpDataSender`), a write to the dialed peer (`TcpDataSender`),
  or a broadcast to every connected client (`TcpServerReceiver.TrySend`).

`DataChannelEndpoints` (one per owning entity) reuses the AIR-82 receiver/sender
classes verbatim — reconcile is the `DataReceiverManager` shape (endpoint-shaped
change bounces the socket; slot edits apply live). The `rtpDecoder` virtual
receiver keeps working unchanged, so scripts/routes and these outputs coexist.

## Redundancy

Docs ride the already-synced `audioEncoders`/`audioDecoders` collections; the
`SyncApplier` audio cases end with `ReconcileDataChannels`. Decoder outputs are
gated by `SuppressExternalOutputs` (the `DataRouteManager.SuppressSends`
pattern) — a locked backup keeps sockets warm but never emits. Input listeners
stay bound on a backup (harmless: the suppressed encoder child drops injected
data with its outputs).

## Constraints

- 200-byte per-message cap end to end (`RtpDataChannel.MaxDataBytes` ==
  `EncodeDataRecord.MaxPayloadBytes` — the 240-byte control-ring slot). The UI
  states it; oversize is dropped + counted (`OversizeDropped`).
- Text-domain plumbing: payloads traverse the receiver subsystem as UTF-8 text
  (lossy for arbitrary binary) — the same contract as data receivers/routes.
- A tcpServer decoder output can be dialed by a receiver/route and looped back
  into an encoder; no loop protection beyond what routes have today.

## Video (AIR-240/241)

The video SRT/UDP transport is an MPEG-TS mux with no side channel, so data
rides a **private data PID** (stream_type 0x06), TLV payload reusing the
`RtpDataChannel` event format, PTS-stamped. Encoder side mirrors the SCTE-35
injection path (`Gst.SendScteSection` precedent); VDECODE parses the PID off its
existing raw-TS tap (`ScteRelay`/`TsReader` pattern), surfaces a virtual
decoder-data receiver, and reuses the same outputs runtime. Same config shape,
same suppress gating.
