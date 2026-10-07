# Bundled font notices

The bundled faces are the source of truth for transcript measurement: `t3-text`
measures these exact bytes, and the iOS client registers the same files with
CoreText. A mismatch between the measured face and the drawn face moves line
breaks, so the set below must match `FaceRole` in `crates/t3-layout/src/style.rs`
one-for-one.

- Geist and Geist Mono, copyright The Geist Project Authors, sourced from
  `vercel/geist-font` release `v1.7.2`.

Both families are distributed under the SIL Open Font License 1.1. The complete
license text supplied by the upstream project is included beside this notice
(`Geist-OFL.txt`).

## Faces

Twelve files, covering every `FaceRole`:

| Family | Files                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Sans   | `Geist`, `Geist-Medium`, `Geist-SemiBold`, `Geist-Bold`, `Geist-Italic`, `Geist-MediumItalic`, `Geist-SemiBoldItalic`, `Geist-BoldItalic` |
| Mono   | `GeistMono`, `GeistMono-Medium`, `GeistMono-SemiBold`, `GeistMono-Italic`                                                                 |

Upstream ships four more (`GeistMono-Bold`, `GeistMono-BoldItalic`,
`GeistMono-MediumItalic`, `GeistMono-SemiBoldItalic`) that no `FaceRole` maps
to. They are deliberately not vendored; add them only alongside a `FaceRole`.

## Provenance

Vendored from `zeronsh/zeron` at revision
`9e1a11158b0626237c814f4bd36f5948483ed797`, which carried the same notice.
