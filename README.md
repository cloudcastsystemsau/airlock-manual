# Airlock documentation

This folder is mirrored as-is to the public
[`airlock-manual`](https://github.com/cloudcastsystemsau/airlock-manual) repo,
served via GitHub Pages at
<https://cloudcastsystemsau.github.io/airlock-manual/>, on every merge to
main — see `.github/workflows/publish-manual.yml`.

- **[User manual](user-manual/README.md)** — operator/admin manual
  ([HTML](user-manual/airlock-manual.html), regenerated via
  `build/build-manual.mjs`; maintenance process in
  [manual-maintenance.md](manual-maintenance.md)).
- **[Scripting guide](scripting-guide.md)** and
  **[examples](scripting-examples.md)** — the `air.*` runtime scripting API;
  ready-to-use scripts under [examples/scripts/](examples/scripts/).
- **[LWRP GPIO spec](lwrp-gpio-spec.md)** — Axia Livewire GPIO protocol notes.
- **[Third-party licences](third-party.md)** and [airlock.mib](airlock.mib)
  (SNMP).
- **[design/](design/)** — engineering design decisions (AIR-nn); internal
  rationale, not user documentation.
- **[spec-review.md](spec-review.md)** — build-spec v0.2 review findings.
