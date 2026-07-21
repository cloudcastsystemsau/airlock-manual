# AIR-15..19 — Low-priority finishing items

Status: **RESOLVED 2026-07-07** (AIR-15 has one external residual).

## AIR-15 — vancData schema pinned (R15)

The official NDI carriage (docs.ndi.video → metadata elements) is:

```xml
<vancData version="1.0">
  <vancPacket did="65" sdid="7" line="10">BASE64</vancPacket>
</vancData>
```

- Payload = base64 of the **8-bit user data words only**. Parity bits (b8 and
  NOT-b8) are **not transmitted**; ADF, DID/SDID, DC and checksum are
  attributes or receiver-derived — never in the payload.
- SCTE-104 per ST 2010: `did="65" sdid="7"` (0x41/0x07); CEA-708 per ST 334.
- `Vanc.BuildVancDataXml` now emits exactly this. The previous placeholder
  (full 10-bit packet as LE uint16) **would not have interoperated** — R15
  was a real defect, caught by pinning the schema.
- `Vanc.BuildPacketWords` (10-bit, parity + checksum) is retained for the
  FAT recording sink's SDI-side verification.
- **Residual (external):** confirm the downstream encoder vendor consumes
  SCTE-104 from NDI vancData — goes in the Cloudcast/downstream vendor pack.

## AIR-16 — SCTE-104 units confirmed (R16)

`pre_roll_time` = 16-bit **milliseconds** (message → insert point);
`break_duration` = 16-bit **tenths of seconds**. Encoder was already correct;
the "verify during FAT" hedge is removed. Formal citation to the exact table
of the purchased ANSI/SCTE 104 edition goes in the FAT results pack.

## AIR-17 — Preview conversion budget (R17)

UYVY→RGB is a manual conversion before SkiaSharp JPEG encode (Skia has no
UYVY input). Budget: 320×180 preview after downscale ⇒ ~57.6k pixels/frame;
at 5 fps × N taps this is well under 1 ms/frame/tap of scalar code on the
Normal-priority PreviewWorker (§3.1) — no SIMD required for v1. Rule: the
downscale happens **before** colour conversion (1/36th the pixels at
1080p→320×180). To be validated with a counter (`previewEncodeMs`) at the
preview milestone.

## AIR-18 — Time sync requirement (R18)

Deployment requirement (goes in the deployment guide with AIR-11's TLS):
Airlock servers must run NTP (or PTP where the plant has it) with monotonic
clocks assumed healthy. Audit timestamps are UTC host time; timecode
verification (NFR-01) and audit correlation across servers depend on ≤100 ms
host clock error. The watchdog and pacer use `Environment.TickCount64`
(monotonic) and are immune to wall-clock steps.

## AIR-19 — GPI simultaneous edges (R19)

Rule implemented (`GpioEdgeFilter`, unit-tested): debounce is **per channel**
(50 ms), first edge wins, later conflicting edges in the window are ignored —
**except DUMP, which always passes**: the safety command must never lose a
race against a bouncing BUILD/ROLLOUT contact.
