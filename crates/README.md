# `crates/`

Rust crates vendored for the native iOS client (`apps/zeron-ios`). See
[`apps/zeron-ios/README.md`](../apps/zeron-ios/README.md) for why these and not others,
and [`apps/zeron-ios/PROVENANCE.md`](../apps/zeron-ios/PROVENANCE.md) for license obligations.

## Origin

Everything here is derived from [`zeronsh/zeron`](https://github.com/zeronsh/zeron) at revision
**`9e1a11158b0626237c814f4bd36f5948483ed797`**. See `PROVENANCE.md` for the full obligations. Zeron is
MIT licensed, © 2026 Wing; `apps/zeron-ios/LICENSE.zeron` is the upstream license text and must
travel with this directory.

Changes made at import, all mechanical:

- Crate names `zeron-text` → `t3-text`, `zeron-markdown` → `t3-markdown`; crate-root paths,
  `use` statements, doc links, and `-p` invocations updated to match.
- Workspace-inherited fields resolved to concrete values (`unicode-segmentation = "1"`,
  `pulldown-cmark = "0.12"`), since t3code has no Rust workspace to inherit from.
- Test asset paths repointed from zeron's repo layout to `assets/` inside this directory.
- Omitted: `crates/t3-text/examples/profile.rs` (a dev profiling harness for zeron's own
  transcript corpus; no role in the iOS client) and `crates/t3-text/benches/` plus its
  `criterion` dev-dependency. The layout benchmark that gates Phase 1 lives in the layout
  engine, not here.

## Crates

| Crate         | Upstream          | Purpose                                                                                                                                                                                                                                                       |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3-text`     | `crates/text`     | UAX #14 break opportunities via ICU4X, rustybuzz advance measurement, cached segment widths, pure-arithmetic line layout. The _prepare_ (once) / _layout_ (per width) split is what lets a virtualized list know every row's exact height before it is shown. |
| `t3-markdown` | `crates/markdown` | Block-level markdown over pulldown-cmark with `IncrementalParser`, so a streamed delta costs O(delta + last block) instead of reparsing the transcript.                                                                                                       |

## Assets

`crates/t3-text/assets/fonts/` holds four Geist faces (~540 KB) vendored from zeron's
`crates/ui/assets/fonts`, plus the OFL text and a `NOTICE.md`. They are required by the
integration suite and are the exact bytes the iOS client must register with CoreText — if Rust
measures a different face than UIKit draws, line breaks disagree and the transcript tears.
See `assets/fonts/NOTICE.md`.

`crates/t3-text/assets/fixture.md` is the markdown corpus `tests/coretext.rs` folds into its
line-break corpus. Vendored rather than left to `unwrap_or_default()` so the parity baseline
below stays the full one. A copy also lives at `crates/t3-layout/src/fixture.md` for the layout
lab and benchmark.

## Verification

```sh
cargo build
cargo test --release
cargo test --release -p t3-layout --lib bench_layout -- --ignored --nocapture
```

155 tests pass. `tests/coretext.rs` is the authority for line-break correctness: it lays corpora
out with `t3-text` and with `CTFramesetter` over the _same font bytes_ and compares line starts.

| Corpus | Exact                 | Line-count agreement |
| ------ | --------------------- | -------------------- |
| swift  | 3528/3528 (100.00%)   | 100.000%             |
| broad  | 8568/8568 (100.00%)   | 100.000%             |
| styled | 5850/5850 (100.00%)   | 100.000%             |
| random | 30240/30240 (100.00%) | 100.000%             |

**48,186 cases, 100.00%.** This matches zeron's documented result, so the vendor did not
regress. Re-run it after any dependency bump — `unicode-segmentation` and `rustybuzz` in
particular are exactly the crates that own line-break rules, and a semver-compatible bump can
still move a break opportunity.

`tests/coretext.rs` is `#![cfg(target_os = "macos")]` and needs `core-text`, so on Linux and
Windows it reports 0 tests rather than failing. Do not read a green non-macOS run as parity
coverage.

### Layout benchmark

`bench_layout` (ignored by default) is the performance gate:

```
cold layout of 3300 rows: 34.2ms (10.35 us/row)
width change: 1.23ms over 3300 rows
streamed token (median of 20): 252us
no-change pass (pure cache walk): 248us
```

zeron's documented figures were ~30 ms cold for the same 3,300 rows, 0.42 ms for a width change,
and 0.19 ms for a streamed token. The residual gap on the token path is structural: zeron detects
unchanged entries by `Arc` pointer equality and does O(1) work per entry, while our feed is owned
deserialized data, so a pass must walk every row to find the one that moved.

Two correctness bugs on this path were also large performance bugs, which is why the benchmark
is a gate rather than a report:

- The message cache compared a cheap signature against a full body hash, so it never hit and
  every pass re-read every message body. Fixing it took the token path from 1.76 ms to 252 µs.
- User bubbles bypassed the cache entirely, so every pass re-prepared every bubble.

Run it before touching `t3-layout/src/rows.rs`. A regression here is the regression users feel.
