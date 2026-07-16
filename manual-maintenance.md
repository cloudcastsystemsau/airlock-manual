# Maintaining the user manual

How `docs/user-manual/` is kept current: analyse what changed, stage a live
instance, capture screenshots, update the markdown, regenerate the HTML,
ship a PR. This is the process behind every manual update to date; the
automated updater (`.github/workflows/update-manual.yml`) should follow the
same phases.

**The artifacts**

| File | Role |
|---|---|
| `docs/user-manual/README.md` | The manual — single source of truth. Edit this. |
| `docs/user-manual/airlock-manual.html` | Generated. Never hand-edit; rebuild with `node build/build-manual.mjs`. |
| `docs/user-manual/img/*.png` | Screenshots, numbered `NN-slug.png`, referenced relatively. |
| `build/build-manual.mjs` | Markdown → branded HTML (nested sidebar, brand tokens); **fails on broken in-page anchors**. |
| `.github/workflows/publish-manual.yml` | Mirrors the **committed** `docs/` tree (the whole folder — the manual cross-links sibling docs like `../scripting-guide.md`) to the public `airlock-manual` repo on merge to main. It does not regenerate — a stale committed HTML ships stale. |

The manual's footer stamp — *"generated against … (main @ `<sha>`,
AIR-1…`<n>`)"* — is the baseline for every update. Bump it every cycle.

---

## Phase 1 — Discover what changed

1. **Baseline** = the sha in the manual's footer stamp.
2. `git log <baseline>..origin/main --oneline` — separate user-visible work
   (SPA, endpoints, operational behaviour) from internal churn (refactors,
   CI, test-only). Merge commits name their tickets.
3. **Jira**: list tickets ≥ the last covered AIR number
   (`project=AIR AND key >= AIR-nnn ORDER BY key`) plus any older tickets
   whose status moved. Trust **merged code over ticket status** — features
   routinely merge while the ticket still says In Progress; document what is
   on main, and only what is on main (open feature branches don't exist yet
   as far as the manual is concerned).
4. **Deep diff report** (fan out to an agent for anything non-trivial):
   `git diff <baseline>..origin/main -- web/Airlock.Web/src src/Airlock.Control docs/design`
   and produce, per feature:
   - **verbatim UI labels** — menu items, tab names, buttons, tooltips,
     hints, banner texts, empty states. The manual quotes the UI exactly;
     paraphrased labels are bugs.
   - **manual section impacts** — which sections are now wrong or
     incomplete, and what to say instead.
   - **screenshot triage** — every existing `img/NN-*.png` as KEEP / RETAKE
     / NEW, with reasons. Anything showing the header/banner is stale when
     the chrome changes.
   - **REST surface** — new/changed endpoints and payload shapes (both for
     the manual's §15 and because the seeding scripts break on removed
     fields and new server-side validation).
   Verify claims **against the code**, not commit messages — e.g. "BUILD is
   licence-gated" survived in the manual long after the gate was hard-wired
   open; only reading `ChannelCommandGate` wiring caught it.
5. Check whether anything already edited the manual (the automated updater,
   a feature branch). Review those edits like a PR: keep what is accurate,
   fix labels/contradictions/Contents entries/the stamp they usually miss.

## Phase 2 — Environment

1. **Worktree, never the developer's checkout**:
   `git worktree add $TEMP/airlock-wtN -b docs/user-manual-update-N origin/main`.
2. **Build**: `export GITHUB_PACKAGES_TOKEN=$(grep GITHUB_PACKAGES_TOKEN .env | cut -d= -f2-)`
   (private Treeks feed), then `./build/build-web.sh` and
   `dotnet build src/Airlock.Control`.
3. **Run**: `dotnet run --project src/Airlock.Control --no-build -- --DataDir <fresh dir> --urls http://localhost:<port>`
   - **Check the port is free first** (`netstat -ano | findstr :<port>`).
     Port 5000 is blocked on the dev box (excluded range) and **5601 is
     Dan's live instance — a seeding script pointed at a live instance will
     authenticate and pollute it** (it happened; the audit log was needed to
     revert). Use 5701+.
   - A fresh `--DataDir` boots with `admin` / `airlock-change-me` and two
     default channels. Runtime artifacts (fills/, audio/, datalogs/,
     encode/*.json) land **CWD-relative in the source tree** — clean them
     after, or run from a disposable worktree.
4. **Licence**: activate the dev serial for licensed captures
   (`POST /api/license/activate {"serial": "..."}`) — activation is
   registry-stored and machine-wide. Screenshots should show the licensed
   state except where the unlicensed behaviour itself is the subject.
   Unlicensed instances watermark everything and **auto-disable receivers
   and scripts after 30 minutes** — a slow unlicensed shoot sabotages
   itself. Two instances on one box collide on NDI sender names; a renamed
   channel only releases its old name at the next engine restart
   (`ALARM_NDI_CREATE_FAILED` on the other instance until then).

## Phase 3 — Seed realistic data (REST)

Everything is seeded over REST with the bootstrap admin token. The standard
fixture (see the session scripts / `build/manual-screenshots.mjs`):

- Rename the default channels to broadcast-plausible names
  (`Sydney TX-1`, `Melbourne TX-2`) and bind both to the **built-in test
  pattern** (`POST /api/test-pattern {"enabled":true}`, then set each
  channel's source to its NDI name) — real NDI, moving bars and burnt-in
  timecode make previews obviously live.
- Generate a **fill** with ffmpeg (a "PLEASE STAND BY" slate + tone), upload
  to `/api/fills`, wait for `ready`, assign to ch1 (delay-to-asset); set ch2
  freeze-frame delay-to-time for variety. Add an all-day fill-schedule row
  so the "active now" pill renders.
- Create the **audio channel** (`kind: "audio"`, `sim` backend for
  reliability), configure insert/squeeze + censor + rollout mix-minus,
  upload an audio fill, add fill + censor schedule rows. For the ASIO
  device-picker screenshot, flip the backend select to `asio` **in the form
  without saving** — the probe populates the pickers.
- **Alert group** with emails, alarm categories and a webhook URL + secret
  (renders the "(signed)" annotation); assign to channels for DUMP and
  alarm routing.
- **Receivers**: TCP server (`lines` framing, file log) + UDP server + a TCP
  client dialled at the local TCP server (self-connection = live Connected
  states); a **delayed data route** to ch1; push ticker lines through a raw
  socket so the live log shows `⇢` received and `⇠ released` pairs.
- **Scripts**: one Lua, one JS, enabled, with realistic sources — **Lua host
  calls use colon syntax (`air:Log`)**, dot syntax fails at runtime. Save a
  v2 so the version-compare view has something to diff. Seed
  **script variables** for the Variables modal and autocomplete.
- **LWRP device** (an unreachable IP shows Connecting — acceptable) with
  GPI/GPO mappings. `pinIndex` is **0-based**; commands are validated
  against the channel's kind (audio verbs on a video channel = 400).
- **Seats / redundancy**: assign licence seats; with a PRIMARY-flagged
  licence, set the redundancy role and mint a sync key for the primary
  panel shot.

## Phase 4 — Screenshots (puppeteer-core + Edge)

`puppeteer-core` driving installed Edge headless (no Chromium download):
viewport **1600×1000 @ deviceScaleFactor 1.5**, window 1680×1050,
`--autoplay-policy=no-user-gesture-required`.

**Selector discipline (every one of these was learned the hard way):**
- Click by **visible text** with an `offsetParent !== null` filter; the SPA
  has no stable test ids.
- Duplicate text exists — the settings modal's *Censor* tab vs the card's
  *Censor* transport button. Scope tab clicks to the actual tab strip
  (find a sibling label unique to that strip, then click within its parent).
- **Modals close via their Close/Cancel buttons — Escape does nothing.** A
  blind "press Escape" leaves the modal over every subsequent shot.
  Conversely a greedy "click every Close" also closes the page-level panel
  and navigates away — close at most one layer, then re-navigate.
- **Native `confirm()` dialogs cannot be screenshotted** (OS-rendered).
  Auto-accept via `page.on('dialog')` and quote the dialog text in prose.
- React inputs: set values with real keyboard `type()` (triple-click to
  select-all first); property assignment + `input` events is unreliable on
  some fields.

**State choreography** happens over REST between shots: `build`, poll
`/api/channels` until `Delayed`, `rollout` for the orange badge, `dump`
(with `{"confirm":true}`) to mint clips, test-pattern off/on for
`ALARM_SOURCE_LOST` (and repeated toggles to fill the alarm history), the
silence-detect **threshold-0 trick** to raise `ALARM_VIDEO_SILENCE` while
previews keep moving, `censor/censoron` and `scte-block/on` for engaged
button states. Give previews/meters settle time (~1–3 s; previews are
~5 fps, telemetry ~10 Hz).

**Verify every capture by looking at it.** Transients ruin frames: engines
mid-restart, encoder crash-loops (no GStreamer on the dev box → NVENC *and*
x264 flap), alarm strips from a previous step, tiles caught mid-config.
Retake rather than caption around a broken frame.

Numbering: keep existing `NN-slug.png` names on retakes (the README
references don't move); append new numbers for new pages; rename only when
the content's meaning changed (e.g. `38-license-grace` → `38-license-panel`
when the grace state ceased to exist).

## Phase 5 — Write the markdown

- **Framing**: Airlock is a *broadcast delay platform for video and audio* —
  the two channel kinds are peers; never present audio as an add-on.
- **Voice**: bold **verbatim UI labels**, explain the operational *why*
  alongside the *what* ("back-dated to cover reaction time"), tables for
  enumerable facts, prose for behaviour. Quote banner/dialog text exactly.
- **Depth follows operator risk**: licensing lifecycle, protection commands,
  persistent state get full subsections; cosmetic fixes and internal
  refactors get nothing (a fixed label is just… correct now).
- **Structure**: two-level Contents (curated h3 sub-entries — everything an
  operator would scan for must appear); cross-reference sections by anchor;
  keep §13.x-style numbering for admin subsections.
- Reconcile, don't append: new features usually contradict old sentences
  ("the four-tab modal", "grace period") — sweep for them.
- Bump the footer stamp: date, `main @ <sha>`, `AIR-1…<n>`, and the
  screenshot-provenance note.

## Phase 6 — Generate and validate

```
node build/build-manual.mjs
```

regenerates `airlock-manual.html` (brand palette, nested sidebar) and
**fails if any in-page anchor doesn't resolve** — heading renames get
caught here. Additionally check every `img/...` reference exists on disk,
and render the file in headless Edge to count broken images (0) and sidebar
entries before committing.

## Phase 7 — Ship

1. Commit README + HTML + images together on the `docs/user-manual-update-N`
   branch; PR to main. The PR body lists coverage per ticket and any product
   inconsistencies found along the way (the manual work regularly surfaces
   real bugs — file or flag them, don't silently write around them).
2. On merge, `publish-manual.yml` mirrors to the public repo/Pages site.
3. Clean up: stop the instance, remove the worktree, revert runtime
   artifacts, and leave the developer's working tree exactly as found.
