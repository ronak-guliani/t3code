# Provenance

Derived from [`zeronsh/zeron`](https://github.com/zeronsh/zeron).

- **Upstream:** `zeronsh/zeron`
- **Revision reviewed:** `9e1a11158b0626237c814f4bd36f5948483ed797` (2026-10-03)
- **License:** MIT, © 2026 Wing — permits forking, vendoring, and relicensing of the derived work,
  provided the copyright notice and permission notice are retained.

## Obligations

1. `LICENSE` — copy zeron's MIT license text into `apps/zeron-ios/LICENSE.zeron`, retaining
   "Copyright (c) 2026 Wing".
2. `THIRD_PARTY_NOTICES.md` — carry forward the notices for components whose source we vendor or
   link. Directly relevant to the fork boundary:
   - **Symbols** (file/folder icons) — MIT, must retain `crates/ui/assets/file-icons/LICENSE.symbols`.
   - **Geist** font binaries measured by `crates/text` — retain the font license.
   - **Tree-sitter** grammars and highlight queries consumed by `crates/syntax` — MIT-compatible,
     attribution per grammar as listed in zeron's `THIRD_PARTY_NOTICES.md`.
   - **gpui-component** (Apache-2.0) and **mermaid-rs-renderer** — desktop-only; **not** in the fork
     boundary, no notice needed unless we later port desktop code.
3. A header note on each vendored file or directory stating origin and upstream revision.

Not in the fork boundary, so not carried: `crates/{ui,harness,engine,voice,theme,preview,mcp,update,rpc}`,
`apps/zeron`, `edge/`, `apps/landing`.

## Vendored paths

| Upstream path                                                                  | Lands at                       | Fate                                  |
| ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------- |
| `crates/text`                                                                  | `crates/t3-text`               | Renamed, deps unchanged               |
| `crates/markdown`                                                              | `crates/t3-markdown`           | Renamed, deps unchanged               |
| `crates/syntax`                                                                | `crates/t3-syntax`             | Renamed, deps unchanged               |
| `crates/mobile/src/layout`                                                     | `crates/t3-layout`             | Extracted from the UniFFI facade      |
| `crates/mobile/src/bin/uniffi-bindgen.rs`                                      | `crates/t3-ios-core`           | Adapted                               |
| `scripts/ios/build-core.sh`                                                    | `scripts/ios/build-t3-core.sh` | Adapted                               |
| `apps/ios/Zeron/{Design,Core,Transcript,Session,Composer,Shell,Threads,Debug}` | `apps/zeron-ios/Zeron/`        | Renamed, `Core/Generated` regenerated |

Explicitly dropped from `apps/ios/Zeron/`: `App/AppModel.swift` (zeron workspace model),
`App/PushNotifications.swift` (zeron relay), `Session/CoreSessionSource.swift` (Loro-backed).
`App/AppDelegate.swift`, `App/SceneDelegate.swift`, and `Zeron.entitlements` are adapted, not dropped.

## Attribution

`apps/zeron-ios/README.md` credits zeron and links this file. Upstream authors are credited in
`CONTRIBUTORS.md`-style notices if requested; zeron's `CONTRIBUTORS.md` is a contribution guide,
not an author list, so it is not carried.

## Divergence policy

We do not track upstream after import. Divergence is expected and intentional: the layout engine is
renamed, the UI is retargeted at our contracts, and `crates/{client,doc,sync,proto,rpc}` are not
taken. See `README.md` for the boundary rationale.
