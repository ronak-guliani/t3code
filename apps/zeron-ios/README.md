# apps/zeron-ios

Native iOS client for t3code, derived from [`zeronsh/zeron`](https://github.com/zeronsh/zeron)'s
iOS app (MIT, © 2026 Wing). See [PROVENANCE.md](PROVENANCE.md) for the exact fork boundary.

**Goal:** zeron's transcript feel — exact row heights, prefix-sum offsets, zero-hitch frame pacing
under streaming — without forking zeron's sync substrate.

## What we take

| From zeron                  | Size         | Status       | Why                                                                                                      |
| --------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `crates/text`               | 4,062        | **vendored** | UAX#14 segmentation + rustybuzz measurement. No zeron deps.                                              |
| `crates/markdown`           | 2,160        | **vendored** | Block model + incremental reparse. Deps: pulldown-cmark only.                                            |
| `crates/syntax`             | 1,354        | **vendored** | Tree-sitter highlighting for 28 languages. Only consumer is `layout/markdown.rs`.                        |
| `crates/mobile/src/layout`  | ~4,300       | partial      | Rows → measured display lists, prefix-sum offsets. **Engine is portable; row model is not** (see below). |
| `apps/ios/Zeron/**/*.swift` | 10,591 lines | Phase 3      | UIKit shell. Only 5 of 36 files touch Rust; the rest is domain-free UI.                                  |
| `scripts/ios/build-core.sh` | 60           | Phase 2      | UniFFI static-lib + binding generation.                                                                  |

Vendored so far: **~12.4k lines + 1.6 MB of Geist faces**, all MIT.

### Correction: `crates/mobile/src/layout` is not domain-free

This plan originally listed `text`, `markdown`, `syntax` and `layout` as four interchangeable
domain-neutral crates. Only the first two are. `layout` splits:

- **Portable engine** — `mod.rs` (the prepare/layout machinery), `display.rs`, `style.rs`,
  `markdown.rs`. No zeron types.
- **zeron-bound row model** — `rows.rs` and `tools.rs` consume `zeron_doc::parts::MessagePart`,
  `zeron_doc::schema::SessionMessageEntry`, `zeron_proto::ToolCall` / `ToolDiff` / `view::*`, and
  `mod.rs:347-372` binds to `zeron_client::SnapshotWatch` and `client_ffi::CoreClient`.

So Phase 1 ports the engine and **rewrites the row model against t3code's thread contracts**
(`packages/contracts/src/orchestration.ts`, `providerRuntime.ts`). Roughly 2,500 of the 4,300
lines are rewrite, not copy. This is why Phase 5 exists, and it is larger than first estimated.

`crates/syntax` is deferred with it: its only consumer is `layout/markdown.rs` code-block
colouring, and it drags 27 tree-sitter grammar crates into an iOS staticlib. The language set
should be decided when we know what our transcripts actually contain.

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

## Deployment target

**iOS 18.0**, matching `apps/mobile`. `t3-text` is pure Rust over rustybuzz and ICU4X with no
Apple-version-gated API, so nothing in the vendored core needs zeron's pinned 26.0. Revisit in
Phase 3: the Swift shell may want 26.0 for Liquid Glass, and that is a UI decision about our own
screens, not a constraint inherited from the measurement engine.

## Phases

### Phase 0 — Provenance & skeleton — DONE

- Vendored `crates/text` → `crates/t3-text` and `crates/markdown` → `crates/t3-markdown` as
  t3code's first Rust workspace members (`/Cargo.toml`, `resolver = "3"`, edition 2024).
  Not `git subtree`: our divergence policy is no upstream tracking, and subtree would vendor
  zeron's other ~390k lines.
- Added `ios` / `ios-dist` cargo profiles, renamed from zeron's `mobile` / `mobile-dist`.
- Vendored four Geist faces + OFL text into `crates/t3-text/assets/fonts/` and the markdown
  corpus into `assets/fixture.md`, then repointed the test paths off zeron's repo layout.
  Fonts are required, not incidental: Rust measures the bytes and CoreText draws them, so a
  mismatch tears line breaks. Geist is kept over t3code's DM Sans because zeron's parity result
  was established on Geist and re-validating it against a new face is Phase 1 work we would
  otherwise have to do anyway.
- `apps/zeron-ios/LICENSE.zeron`, `crates/README.md` (import deltas, verification, baseline).
- **Gate:** `cargo build` green, `cargo test --release` 128 passed / 0 failed. CoreText parity
  reproduced exactly at **48,186 cases, 100.00%** line-start agreement (swift 3528, broad 8568,
  styled 5850, random 30240) — identical to zeron's documented result, so the vendor did not
  regress.

### Phase 1 — Layout engine + row model — PARTIAL

Landed `crates/t3-syntax` and `crates/t3-layout`, and rewrote the row model against t3code's feed.
Three tests failed on first run and caught real placement bugs; see the gate below.

**Done**

- `t3-syntax` vendored whole (28 languages, 27 grammar crates). Cost not yet measured —
  Phase 2 should record static-lib size and build time before we accept it for a phone.
- `t3-layout` = the portable engine (`lib.rs`, `display.rs`, `style.rs`, `markdown.rs`) plus
  `feed.rs` and a rewritten `rows.rs`. `file_icons.rs` and `tools.rs` were **not** taken.
- `TranscriptView::attach` and the `SnapshotWatch`/`CoreClient` binding are gone; `set_input`
  is the only feed path, and Phase 5 owns what calls it.
- All `#[uniffi::*]` attributes stripped — Phase 2 adds the facade crate, so the engine stays
  plain Rust and testable without a codegen dependency.
- Row model mirrors `buildThreadFeed()`'s output, not zeron's `MessagePart` union. See
  `crates/t3-layout/src/feed.rs`.

**Not done, and it is bigger than estimated**

`tools.rs` (~1,180 lines) is not ported. zeron's version renders per-tool-type detail — file
badges, inline diffs, subagent cards — driven by `zeron_proto::ToolCall`'s variants. t3code has
no equivalent type to port _from_: tool semantics live in
`OrchestrationThreadActivity.payload` (`Schema.Unknown`) and are resolved by
`packages/client-runtime/src/work-log/presentation.ts` (934 lines) plus the grouping in
`apps/mobile/src/lib/threadActivity.ts`.

This crate does not re-derive any of that. `FeedActivity` carries an already-resolved
`heading` / `preview` / `body` / `icon` / `failed` / `live`, and the engine paints it. That is
deliberate: duplicating the projection in Rust would create a second source of truth that
silently drifts from the RN app. The cost is that t3code-specific rows (file badges, per-file
diff blocks) need Rust work later, driven by real transcripts rather than guessed at now.

**Gate**

| Metric                  | zeron   | here                                   |
| ----------------------- | ------- | -------------------------------------- |
| Cold layout, 3,300 rows | ~30 ms  | **41.4 ms** (median of 3, 12.5 µs/row) |
| Width change            | 0.42 ms | 2.5 ms                                 |
| Streamed token          | 0.19 ms | 1.76 ms (median of 20)                 |

`cargo test --release`: **155 passed, 0 failed**, clippy clean.

The streamed-token figure is a different quantity, not a regression: zeron hands the layout
thread `Arc<SessionMessageEntry>` and detects unchanged entries by pointer equality, so its
per-pass work is O(1) per entry. Our feed is owned, deserialized data, so a pass walks all
3,300 rows (~1.66 ms floor for a _no-change_ pass) to find the one that moved. Measured against
the contract's `updatedAt` so unchanged messages skip re-hashing their bodies; the remainder is
HashMap and `Arc` traffic. At 10 tokens/sec that is under 2% of one background thread — not
user-visible, but it is the number to beat if it ever becomes one.

`paint_matches_measure_at_many_widths` earned its keep: it caught two genuine bugs where
`place_text`'s return value (a height) was being assigned as a new `y`, so painted runs fell
outside their row's measured height. That is exactly the class of defect the geometry assertions
exist to find, and it is why the assertion checks run bounds rather than "row painted something".

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

Phase 1 is partially landed: the engine and its gate are done, tool/activity presentation is
not. It is a self-contained increment — nothing in Phase 2 depends on it.

Phases 0-3 need no server changes and no protocol decisions. If Phase 3's hitch numbers hold,
the remaining risk is concentrated in Phase 5 and the project is worth continuing.

## Verification

```sh
cargo build && cargo test --release
```

Phase 0 result: **128 passed, 0 failed**, and the CoreText parity baseline reproduced exactly at
48,186 cases / 100.00%. See [`crates/README.md`](../../crates/README.md) for the per-corpus table
and the caveat that `coretext` reports 0 tests off macOS.

Because `cargo` is not yet wired into `pnpm test`, CI does not run these. Adding that is Phase 2
work — it belongs with the build pipeline, not here, so that Phase 0 does not add a Rust toolchain
install to every JavaScript-only pull request.
