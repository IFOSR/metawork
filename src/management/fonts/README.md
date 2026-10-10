# Report PDF fonts

Noto Sans SC Regular and Bold, from [Noto CJK](https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC).
Downloaded 2026-10-10. Unmodified upstream OpenType files, redistributed under
the SIL Open Font License 1.1 in `OFL.txt`.

These fonts cover Latin and Simplified Chinese report text. They are embedded
as subsets in exported PDFs, so readers do not need locally installed fonts.
The runtime build copies this directory to `dist/fonts`; release packaging
includes it as part of `dist`. No runtime network download is needed.

SHA-256:

- Regular: `faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9`
- Bold: `c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0`
