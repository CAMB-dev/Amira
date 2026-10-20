# Standalone server packaging

`amira-server` has a separate build entry and release namespace. It is not bundled in
npm platform packages, and does not change the CLI's seven build targets or five npm
platforms. The extension `API_VERSION` is unchanged by packaging.

## Artifacts and trust

Production builds run on Linux CI with Bun 1.4.2:

```sh
bun scripts/build-server.ts --all --version "$VERSION" --channel "$CHANNEL" --build-id "$SOURCE_SHA"
bun scripts/server-manifest.ts generate
bun scripts/server-manifest.ts sign --key-env SIGNING_KEY
bun scripts/server-manifest.ts verify --key-env SIGNING_KEY
```

`CHANNEL` is `stable` or `next`; `SOURCE_SHA` is the pinned source commit. Source and
unspecified development builds are labelled `development-unverified`, not as released
builds merely because their package versions match. The production targets and raw executable filenames
are:

| Target | File |
| --- | --- |
| Linux x64 baseline | `amira-server-bun-linux-x64-baseline` |
| Linux ARM64 | `amira-server-bun-linux-arm64` |

The x64 executable uses Bun's baseline CPU target, not its AVX2 target. These are Linux
glibc executables; Windows is not a supported remote deployment platform.

Output in `dist/` also includes:

- `server-build.json`: validated build provenance, separate from CLI `build.json`.
- `SERVER_SHA256SUMS`: SHA-256 of the raw executable bytes, separate from CLI archive
  `SHA256SUMS`.
- `server-manifest.json` and `server-manifest.json.sig`: deterministic UTF-8 JSON and
  an Ed25519 signature of its exact bytes. The manifest identifies `product` as
  `amira-server` and contains `version`, `channel`, `buildId`, and `artifacts`, each with `target`,
  `file`, raw byte `size`, and raw `sha256`.

The signature uses the release signing key. Production nightly/release builds fail
without it. Only CI/release dry runs may use `--ephemeral true`; those signatures are
not production trust roots. Verify the signature against the trusted release public
key before trusting the manifest, then verify size and hash before executing or
uploading a binary. An archive hash is not a substitute for the raw executable hash.

CLI installers, archive manifests, channel pointers and npm staging continue to use
only their existing CLI metadata. The server artifacts are separate release assets,
not new optional npm dependencies. A local artifact source can consume this signed
bundle without requiring downloads on the remote host; normal acquisition/cache and
explicit offline-bundle selection belong to the remote installer.

## Immutable retries

A release retry downloads the published raw server executables, manifest, signature,
and checksums together with the existing CLI assets. It verifies the original
signature and runs:

```sh
bun scripts/server-manifest.ts recover --version "$VERSION" --channel "$CHANNEL" --build-id "$SOURCE_SHA" --target all
```

Recovery compares the expected version/channel/build ID/full target set and every executable's
raw size/hash against the exact published manifest bytes, validates the separate
checksum file, then reconstructs only `server-build.json`. It does not recompile,
rewrite, resign, upload to, or otherwise mutate a published release. Missing or
changed artifacts fail closed. A failed fresh build removes stale server provenance
and signatures before compilation; it cannot label partially replaced binaries with
old metadata. Nightly publication retains its existing fresh-tag, draft-upload-once
policy rather than reusing a published tag.

## Offline Windows verification

Do **not** cross-compile Linux locally for offline verification: Bun may fetch target
runtimes. Packaging unit tests inject a fake compiler and fixture executables for
both Linux targets. A Windows x64 maintainer may explicitly compile the same entry
with the native, test-only option:

```sh
bun scripts/build-server.ts --native-windows-test
# In an isolated environment, with all homes redirected before process startup:
./dist/amira-server-native-test.exe --version
./dist/amira-server-native-test.exe --self-check
```

This option cannot be combined with `--all` or `--target`; its output is never listed
in production metadata, checksums or signed manifests. `--version`, `--version-json`
and `--self-check` do not import the server composition root or load settings.
`--version-json` reports `product`, `version`, `channel`, `buildId` and the compiled `target`. Self-check verifies the
process and stdout workers' readiness without launching a shell child, reading theme
assets, connecting to providers, or accessing a user home. The build checks the actual
runtime import graph and rejects TUI/TUI-kit, CLI main/print and bundled theme assets.

Read `scripts/TESTING.md` before running tests. Start the test launcher with owned
temporary local home, remote home and workspace directories; redirect `AMIRA_HOME`,
`HOME`, `USERPROFILE` and XDG directories before the test preload starts. Clear provider
secrets and every `AMIRA_LIVE_*` variable; the existing home preload deliberately
retains live opt-ins, so it is not sufficient on its own. Do not use real SSH, network
providers, downloads or a real Amira directory. Within that isolated offline harness:

```sh
bun test scripts/server-build.test.ts scripts/server-manifest.test.ts scripts/server-native.test.ts scripts/build.test.ts scripts/build-metadata.test.ts scripts/sign-manifest.test.ts scripts/release-workflow.test.ts scripts/npm-pack.test.ts
```

The graph test bundles source without native or cross-target compilation. All Linux
artifact-content tests use fixtures, so they do not prove a Linux executable runs.

## Native smoke and remaining acceptance

CI compiles production Linux x64 baseline/ARM64 artifacts, smoke-tests x64 baseline,
and compiles/smokes the native Windows test-only server. Release/nightly smoke stages
verify raw sizes/hashes and run the Linux x64 baseline binary without installing Bun.
**Linux ARM64 execution remains unverified** until a native runner or maintainer
provides results; cross-compilation and checksum tests are not execution evidence.

Before claiming Linux deployment support, run the actual binaries on both
architectures without Bun/Node installed. Verify minimum CPU/libc, executable
permissions, process/stdout workers, shell tools and private socket ownership, then
exercise detach/reconnect and interrupted installation on a real Linux/SSH host.
Verify Linux `SO_PEERCRED` UID/PID binding on Bun's connected socket descriptor, including
replaced socket paths and UID/process mismatches; unavailable peer proof must fail closed.
Real SSH/provider checks are maintainer opt-in and are not part of offline Windows
acceptance.
