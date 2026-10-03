# apps/zeron-ios

Native iOS client for t3code, derived from [`zeronsh/zeron`](https://github.com/zeronsh/zeron)'s
iOS app (MIT, © 2026 Wing). See [PROVENANCE.md](PROVENANCE.md) for the exact fork boundary.

**Goal:** zeron's transcript feel — exact row heights, prefix-sum offsets, zero-hitch frame pacing
under streaming — without forking zeron's sync substrate.

## What we take

| From zeron                  | Size         | Why                                                                     |
| --------------------------- | ------------ | ----------------------------------------------------------------------- |
| `apps/ios/Zeron/**/*.swift` | 10,591 lines | UIKit shell. Only 5 of 36 files touch Rust; the rest is domain-free UI. |
| `crates/text`               | 4,062        | UAX#14 segmentation + rustybuzz measurement. No zeron deps.             |
| `crates/markdown`           | 2,160        | Block model + incremental reparse. Deps: pulldown-cmark only.           |
| `crates/syntax`             | 1,354        | Tree-sitter highlighting. Deps: tree-sitter grammars only.              |
| `crates/mobile/src/layout`  | ~4,300       | Rows → measured display lists, prefix-sum offsets, `rowsIn(y0,y1)`.     |
| `scripts/ios/build-core.sh` | 60           | UniFFI static-lib + binding generation.                                 |

Total: **~22.5k lines**, all MIT, all domain-neutral.

## What we do not take

`crates/{client,doc,sync,proto,rpc}` (~37k Rust) and `edge/` (~6.5k TS). Loro CRDT convergence
solves multi-writer sync; t3code threads have one writer (`OrchestrationLatestTurnState`,
approvals, sandbox policy, delegation are all server-authoritative — `packages/contracts/src/orchestration.ts:82-420`).
Our offline-queue requirement is already met by `apps/mobile/src/state/thread-outbox.ts`.
WorkOS is dropped — we already run Clerk. Our relay is already `packages/client-runtime/src/relay/managedRelay.ts`.

## The seam

`protocol SessionSource` (`Session/SessionSource.swift:60`) is where the UI stops and data begins.
zeron proves it works with no network via `FixtureSessionSource`. We add a third implementation,
`T3SessionSource`, backed by our contracts. Transcript rows never cross FFI — Rust subscribes and
publishes `LayoutFrame`s; Swift only paints at the given coordinates.

## Phases

### Phase 0 — Provenance & skeleton (1 day)

- `git subtree add` zeron at the recorded revision; copy `LICENSE` + `THIRD_PARTY_NOTICES.md`.
- Register `crates/{text,markdown,syntax,layout}` as t3code workspace members, renamed
  `t3-text`, `t3-markdown`, `t3-syntax`, `t3-layout`.
- **Decision:** deployment target. zeron pins `IPHONEOS_DEPLOYMENT_TARGET = 26.0`; t3code mobile
  targets 18.0. Pick 18.0 unless the vendored crates need 26.
- **Gate:** `cargo build -p t3-text -p t3-markdown -p t3-syntax -p t3-layout` green on stable.

### Phase 1 — Layout core, domain-free (1 week)

- Vendor the four crates. Strip every `zeron_*` path in `Cargo.toml`; keep only third-party deps.
  The retained sets are `rustybuzz`, `icu-segmenter`, `icu-properties`, `unicode-segmentation`,
  `unicode-bidi`, `hashbrown`, `rustc-hash` (`crates/text`); `pulldown-cmark`
  (`crates/markdown`); `tree-sitter` plus the pinned grammars (`crates/syntax`). Verified against
  upstream `Cargo.toml` — none of these four crates references the zeron workspace.
- Port `crates/text/tests/coretext.rs` (line-break parity against CoreText on the same font bytes).
- Port `crates/mobile/src/layout/tests.rs` and `crates/mobile/src/layout/fixture.md` verbatim —
  these are the paint/measure-agreement, streaming-equals-full-parse, and prefix-reuse assertions.
- **Gate:** all ported tests pass. `cargo test --release -p t3-layout --lib bench_layout -- --ignored`
  reproduces ~30 ms cold layout for 3,300 rows.

### Phase 2 — UniFFI facade & build pipeline (3 days)

- New `crates/t3-ios-core`: `uniffi::setup_scaffolding!("t3_core")`, re-exporting the layout surface
  plus `TextSystem`, `TranscriptView`, `LayoutListener`, `PlatformMeasurer`.
- Port `scripts/ios/build-core.sh` → `build-t3-core.sh`; two cargo profiles (`ios`, `ios-dist`).
- Xcode project with the "Rust core" build phase, `LIBRARY_SEARCH_PATHS` → `libt3_ios_core.a`,
  `SWIFT_INCLUDE_PATHS` → modulemap.
- **Gate:** `xcodebuild … build` links the static lib; generated bindings committed and CI fails on drift.

### Phase 3 — Swift shell, fixture-driven (2 weeks)

Port in this order, keeping `FixtureSessionSource` wired at every step so nothing needs a network:

1. `Design/` — Palette, Glass, StatusGlyph, Toast, Wallpaper (~1,200 lines)
2. `Core/Fonts.swift` — register the exact font bytes Rust measures
3. `Transcript/` — `TranscriptListView`, `RowView`, `RowModel`, `ToolViews`, `FrameRelay` (~1,800)
4. `Debug/TranscriptLabViewController` — fixture markdown + on-screen hitch meter
5. `Session/`, `Composer/`, `Shell/`, `Threads/` — screens and chrome (~4,500)

Retarget the vendored `SessionSource` protocol; leave `CoreSessionSource` behind.

- **Gate:** `ZeronUITests` equivalents green — `SessionFlowTests`, `LineBreakAccuracyTests`,
  `ScrollPerformanceTests`, `IPadLayoutTests`. **Hitch ratio 0 over 3,300-row flings, idle and streaming.**
  This is the phase that proves the felt-speed claim before any transport work starts.

### Phase 4 — Transport seam (1 week, no implementation)

- Freeze the `T3SessionSource` contract: `send`, `stop`, `answer`, `queueAction`, `retryDelivery`,
  `beginEdit`/`finishEdit`, `chipMenu`, `loadImage`, `searchFiles`, plus `SessionChrome`.
- Write the Rust-side trait the client must satisfy. Decide the wire: Effect RPC over WS vs the
  existing `/mobile/v1` protocol (`apps/server/src/mobileProtocol.ts`, currently server-only).
- **Gate:** an interface both a fixture impl and a real impl can satisfy, reviewed and merged.
  Nothing downstream starts until this is frozen.

### Phase 5 — Rust client over t3code contracts (4-6 weeks, riskiest)

- Implement `T3CoreClient` mirroring `zeron-client`'s shape (registry, session handle, listener)
  but speaking our contracts. Emit the `ClientEvent` set the Swift layer consumes.
- Wire `TranscriptView.attach` to our streaming thread events instead of Loro doc updates.
- **Gate:** send → stream → steer → interrupt → queue-while-offline round-trips against a real
  `t3 serve`, asserted in `LiveStackTests` style with a mock provider.

### Phase 6 — Ship parity (2 weeks)

- Push rule — port `edge/src/push-notify.ts` (99 lines: `working`/`awaiting`/`errored` →
  done/input/failed) and `edge/src/apns.ts` (83 lines). Register devices against our existing relay.
- Live Activity + WidgetKit agent-awareness, mirroring `apps/mobile/src/widgets/AgentActivity.tsx`.
- EAS/TestFlight pipeline; auto-update (zeron has hourly in-app checks; ours is `updates.enabled: false`).
- **Gate:** Maestro physical-device run: pair by QR, run a turn from another device, get the push, tap through.

## Dependencies between phases

```
0 ──▶ 1 ──▶ 2 ──▶ 3 ──┬─▶ 4 ──▶ 5 ──▶ 6
  (no network needed)   │
  └─────────────────────┘
  Phase 3 gate is the go/no-go for the whole project.
```

Phases 0-3 need no server changes and no protocol decisions. If Phase 3's hitch numbers hold,
the remaining risk is concentrated in Phase 5 and the project is worth continuing.
