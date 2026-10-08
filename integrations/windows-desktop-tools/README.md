# Windows Desktop build dependencies

The manifest pins official Windows x64 Node and PortableGit archives and their
published SHA256 values. PortableGit retains Bash, libraries, templates and
licenses. The Executor is the pinned upstream Pi CLI, with an independent npm
lock; it is not the vendored MetaWork Planner/TUI.

Only the build runner downloads or installs these dependencies. The Desktop
candidate must carry the complete verified tree; users do not run npm or install
Node, Git, Python or Visual Studio. Python/PDF remains owned by
`scripts/prepare-pi-pdf.mjs` and its existing fixed archives/requirements.

The Windows builder requires Node 22 and 7-Zip. The extraction tool is a build
prerequisite, not a product dependency. Download hashes are checked before
extraction. Keep all upstream license/notice files in the packaged trees.

Tool preparation and native execution probes do not constitute Desktop release
acceptance. Windows 11 installation, dependency closure, production native
adapter, authentication and lifecycle gates remain required by the build plan.
