# System Pi PDF integration

This is the bounded read/inspect subset of `@joemccann/pi-pdf` 1.0.1,
https://github.com/joemccann/pi-pdf, MIT (see LICENSE).
The npm archive SHA-1 is `9bd16f65a5f78f91f5729786b722ef729d2fb22b`.

Existing Pi tool names and schemas are retained: `pdf_info`, `pdf_extract_text`,
`pdf_extract_tables`, `pdf_to_images`. This extension is loaded by the installed
system Pi, not the vendored Planner. No `read_document` interface is introduced.

Local changes: bounded explicit page selection, streaming progress, no default
wall-clock timeout, cancellation in the Pi attempt process group, isolated pinned Python imports,
and PDFium rendering in place of pdf2image/host Poppler. Upstream already lists
pypdfium2 as a PDF dependency. Generation, encryption and form mutation tools
are not enabled. Rendered PNGs are read with Pi's existing image read tool.

Python dependencies are installed during the build into an isolated directory
and shipped in the release; their license files remain in the distribution.
pypdf (BSD-3-Clause), pdfplumber (MIT), pypdfium2 (Apache-2.0/BSD-3-Clause,
with PDFium third-party notices), Pillow (MIT-CMU) are pinned in requirements.txt.
The release also bundles relocatable CPython 3.12.12 from Astral
python-build-standalone build 20251014 (PSF-2.0 and bundled dependency notices).
Archive SHA-256 values live in scripts/pi-pdf-python.json; no system Python or
Xcode installation is required. Builds target the host platform/architecture.
Native macOS arm64 is validated; Darwin x64 and Linux x64/arm64 asset hashes are
pinned but those targets still need their own release validation. Windows has
no prepared distribution in this integration and fails at build preparation.
Updates must rebuild native wheels for the pinned interpreter/target and repeat
Pi tool, cancellation and vision acceptance. Existing model revisions are not
rewritten when the extension is updated.
