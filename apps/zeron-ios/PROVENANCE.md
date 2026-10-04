# Provenance

Derived from [`zeronsh/zeron`](https://github.com/zeronsh/zeron).

- **Upstream:** `zeronsh/zeron`
- **Revision reviewed:** `9e1a11158b0626237c814f4bd36f5948483ed797` (2026-10-03)
- **License:** MIT, © 2026 Wing — permits forking, vendoring, and relicensing of the derived work,
  provided the copyright notice and permission notice are retained.

## Obligations

1. `LICENSE.zeron` — zeron's MIT license text, retaining "Copyright (c) 2026 Wing", sits beside
   this file. It governs everything under `crates/`.
2. Bundled font notices — `crates/t3-text/assets/fonts/NOTICE.md` and `Geist-OFL.txt`. Geist and
   Geist Mono are SIL Open Font License 1.1, © The Geist Project Authors, from `vercel/geist-font`
   `v1.7.2`. Required because the vendored faces are compiled into the client binary.
3. Third-party Rust dependencies are consumed from crates.io, not vendored, and carry their own
   licenses: `rustybuzz`, `icu_segmenter`, `icu_properties`, `unicode-segmentation`, `unicode-bidi`,
   `hashbrown`, `rustc-hash`, `pulldown-cmark`, plus macOS-only dev deps `core-text`,
   `core-foundation`, `core-graphics`.
4. Origin is recorded per crate and per phase in [`crates/README.md`](../../crates/README.md) and
   in the "What we take" table in [`README.md`](README.md), rather than as a header on every file —
   a per-file banner would conflict with upstream formatting on every future sync of a file.

Not in the fork boundary, so not carried: `crates/{ui,harness,engine,voice,theme,preview,mcp,update,rpc}`,
`apps/zeron`, `edge/`, `apps/landing`.

## Vendored paths

### Landed in Phase 0

| Upstream path                                                            | Lands at                           | Fate                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------- |
| `crates/text`                                                            | `crates/t3-text`                   | Renamed; `examples/`, `benches/` and the `criterion` dev-dep omitted |
| `crates/markdown`                                                        | `crates/t3-markdown`               | Renamed                                                              |
| `crates/ui/assets/fonts/{Geist,Geist-Bold,Geist-SemiBold,GeistMono}.ttf` | `crates/t3-text/assets/fonts/`     | Copied, with `licenses/Geist-OFL.txt`                                |
| `crates/mobile/src/layout/fixture.md`                                    | `crates/t3-text/assets/fixture.md` | Copied (in-boundary; used as the `coretext` corpus)                  |

### Landed in Phase 1

| Upstream path                                              | Lands at           | Fate                               |
| ---------------------------------------------------------- | ------------------ | ---------------------------------- |
| `crates/syntax`                                            | `crates/t3-syntax` | Copied with `queries/`             |
| `crates/mobile/src/layout/{mod,display,style,markdown}.rs` | `crates/t3-layout` | Copied; `mod.rs` became `lib.rs`   |
| `crates/mobile/src/layout/{rows,tests}.rs`                 | `crates/t3-layout` | Rewritten — the data model is ours |

### Deferred

| Upstream path                                                                  | Lands at                               | Fate                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `crates/mobile/src/layout/{mod,display,style,markdown}.rs`                     | `crates/t3-layout`                     | Engine slice; copy (Phase 1)                                                          |
| `crates/mobile/src/layout/{rows,tools}.rs`                                     | `crates/t3-layout`                     | **Rewrite** against t3code contracts — consumes `zeron_doc` / `zeron_proto` (Phase 1) |
| `crates/mobile/src/layout/{tests.rs,fixture.md}`                               | `crates/t3-layout`                     | Port (Phase 1)                                                                        |
| `crates/syntax`                                                                | `crates/t3-syntax`                     | Copy, language set to be decided (Phase 1)                                            |
| `crates/mobile/src/client_ffi`, `crates/mobile/src/bin/uniffi-bindgen.rs`      | `crates/t3-ios-core`                   | Adapt (Phase 2)                                                                       |
| `scripts/ios/build-core.sh`                                                    | `apps/zeron-ios/scripts/build-core.sh` | Adapt (Phase 2)                                                                       |
| `apps/ios/Zeron/{Design,Core,Transcript,Session,Composer,Shell,Threads,Debug}` | `apps/zeron-ios/Zeron/`                | Rename; `Core/Generated` regenerated (Phase 3)                                        |

Deliberately dropped from `apps/ios/Zeron/`: `App/AppModel.swift` (zeron workspace model),
`App/PushNotifications.swift` (zeron relay), `Session/CoreSessionSource.swift` (Loro-backed).
`App/AppDelegate.swift`, `App/SceneDelegate.swift`, and `Zeron.entitlements` are adapted, not dropped.

## Attribution

`apps/zeron-ios/README.md` credits zeron and links this file. Upstream authors are credited in
`CONTRIBUTORS.md`-style notices if requested; zeron's `CONTRIBUTORS.md` is a contribution guide,
not an author list, so it is not carried.

## Divergence policy

We do not track upstream after import. Divergence is expected and intentional: crates are renamed,
the UI is retargeted at our contracts, `layout`'s row model is rewritten, and
`crates/{client,doc,sync,proto,rpc}` are not taken. See `README.md` for the boundary rationale.
