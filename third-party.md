# Third-party dependencies

Supply-chain register (build spec §14.5). Every dependency pinned; hashes for
vendored/binary artifacts recorded here.

**Customer-facing attributions live in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)**
(shipped with the product, with full licence texts in the installer's
`licenses/` folder). This register is the internal engineering view; the
NOTICES file is the authoritative attribution list including the Encode
option's GStreamer/codec stack.

## Vendored

| Component | Version / commit | Hash | Licence |
|---|---|---|---|
| NdiLibDotNetCoreBase (fork → `Airlock.Interop`) | TODO: record upstream commit at vendoring | TODO | MIT |

Fork changes:
1. `audio_frame_v3_t.FourCC` made public, defaults to FLTP (`0x70544C46`).

## Binaries

| Binary | Version | Hash | Licence / notes |
|---|---|---|---|
| NDI runtime redistributable | TODO: pin at first NDI-wired build (`build/ndi-pin.json`) | TODO | NDI SDK licence — attribution + trademark terms; release gate `build/check-ndi-age.ps1` (NFR-08, AIR-4: fail if unpinned or ≠ latest SDK, warn >30 days) |
| FFmpeg shared **LGPL** build (BtbN / gyan.dev) | 7.x TODO | TODO | LGPL-2.1+; invoked as a separate process only — never linked (§14.3) |

## NuGet (pinned in csproj; lockfiles recommended before v1)

| Package | Version | Licence |
|---|---|---|
| LiteDB | 5.0.21 | MIT |
| Concentus | 2.2.2 | MIT — pure managed libopus port; browser audio monitoring encode (AIR-22), no native surface |
| MailKit | 4.8.0 | MIT — SMTP alert email (AIR-23) |
| Novell.Directory.Ldap.NETStandard | 4.0.0 | MIT — LDAP/AD authentication (AIR-30); pure managed, no native libldap |
| Serilog.AspNetCore | 8.0.3 | Apache-2.0 |
| Serilog.Formatting.Compact | 3.0.0 | Apache-2.0 |
| Microsoft.AspNetCore.Authentication.JwtBearer | 8.0.11 | MIT |
| NLua | 1.7.3 | MIT — Lua scripting engine (AIR-61); bundles native Lua 5.4 (MIT) via KeraLua |
| Jint | 4.11.0 | BSD-2-Clause — pure-managed JavaScript engine (AIR-62) |
| Microsoft.CodeAnalysis.CSharp.Scripting | 4.11.0 | MIT — Roslyn C# scripting (AIR-63); **pinned to 4.11 to match the SDK compiler** (avoids CS9057 analyzer skew) |
| SkiaSharp (+ NativeAssets.Linux.NoDependencies) | 2.88.9 | MIT (binding); native Skia BSD-3-Clause — server-side preview rendering |
| xunit | 2.9.2 | Apache-2.0 (test-only) |
| xunit.runner.visualstudio | 2.8.2 | Apache-2.0 (test-only) |
| Microsoft.NET.Test.Sdk | 17.11.1 | MIT (test-only) |
| FluentAssertions | 6.12.2 | Apache-2.0 (test-only) — **pin at 6.x; 7.0+ is a commercial licence** |

Deliberately NOT used: SixLabors.ImageSharp (Split License — commercial licence
required at Cloudcast revenue; SkiaSharp is used instead, now that the preview
pipeline has landed), any third-party ring buffer / frame pool / SCTE-104 package
(hot-path and wire-format code is first-party, §14.2).

## Encode option — GStreamer / codec stack (native; dynamic or out-of-process)

Full licence analysis: [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) §1
and `docs/design/encode-option.md` (D5/D6). Nothing here is statically linked;
x264 is customer-installed only and never distributed by Cloudcast.

| Component | Licence | Consumption |
|---|---|---|
| GStreamer 1.20+ (core/base/good/bad/ugly/libav) | LGPL-2.1+ | dynamic load + P/Invoke (gstreamer/gstapp/gstmpegts-1.0) |
| libsrt (`srtsink`) | MPL-2.0 | dynamic (SRT contribution transport) |
| Cisco OpenH264 (`openh264enc`) | BSD-2-Clause | dynamic (tier-2 software fallback) |
| Fraunhofer FDK AAC (`fdkaacenc`) | FDK AAC licence (D5 accepted) | dynamic (default AAC) |
| TwoLAME (`twolame`) | LGPL-2.1+ | dynamic (MP2 option, patent-expired) |
| NVIDIA NVENC (`nvh264enc`) | plugin LGPL + NVIDIA SDK EULA | dynamic (tier-1 default; customer driver) |
| x264 (`x264enc`) | GPL-2.0+ | **customer-installed only, never distributed** (D6) |

## npm (bundled into the SPA)

See `web/Airlock.Web/package.json`; `npm audit` gates CI. Attributions in
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) §4.

| Package | Licence |
|---|---|
| react, react-dom, @tanstack/react-query, tailwindcss | MIT |
| monaco-editor, @monaco-editor/react | MIT — Scripts console editor (AIR-66); lazy-loaded, bundled offline |
| Inter variable font (@fontsource-variable/inter) | SIL OFL-1.1 |
| vite, @vitejs/plugin-react, postcss, autoprefixer (build-only) | MIT |
| typescript (build-only) | Apache-2.0 |

## Private feed (nuget.pkg.github.com/cloudcastsystemsau — AIR-39)

| Package | Version | Notes |
|---|---|---|
| TreeksLicensingLibraryCore | 1.0.3 | Cloudcast first-party licensing library (Treek's Licensing, .NET Standard 2.0). Published by the TreeksLicensingLibrary repo's tag-driven workflow. Restore auth: `GITHUB_PACKAGES_TOKEN` env (PAT with read:packages; CI uses the PACKAGES_TOKEN secret). |
