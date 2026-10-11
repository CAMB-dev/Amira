# Building Amira

Use Bun **1.4.2** in a checkout of this repository:

```sh
bun install --frozen-lockfile
bun run build                       # Current platform and architecture
bun run build --target bun-windows-x64
bun run build:all                   # All seven targets
bun run build:all --version 0.1.0-nightly.20261011 --channel next
```

The default version comes from `packages/cli/package.json`; `--version` overrides it. The default channel is `stable`; `--channel stable|next` overrides it. Bun can cross-compile all targets on one machine, downloading the matching Bun runtime when needed.

| Target | Archive |
| --- | --- |
| `bun-windows-x64` | `.zip` |
| `bun-windows-x64-baseline` | `.zip` |
| `bun-linux-x64` | `.tar.gz` |
| `bun-linux-x64-baseline` | `.tar.gz` |
| `bun-linux-arm64` | `.tar.gz` |
| `bun-darwin-x64` | `.tar.gz` |
| `bun-darwin-arm64` | `.tar.gz` |

The x64 baseline targets support older CPUs without AVX2. Output is `dist/amira-<target>/amira` (`amira.exe` on Windows), with an archive at `dist/amira-<target>.zip` or `.tar.gz`. `dist/SHA256SUMS` contains SHA-256 checksums for the archives. `dist/` is ignored by Git.

The single-file executable includes the Bun runtime, built-in assets and Worker entrypoints; users do not need Bun installed to run it. External TypeScript extensions are supported; JSX extensions are not supported in the compiled executable.

## Check a build

Run these commands on a machine matching the executable's OS and architecture:

```sh
./dist/amira-bun-linux-x64/amira --version
./dist/amira-bun-linux-x64/amira --self-check
```

On Windows, use `dist/amira-bun-windows-x64/amira.exe`. `--version` prints the version, channel and target. The hidden `--self-check` prints JSON and exits non-zero if a Worker did not send `ready` (including inline fallback), a built-in theme is unreadable, or Windows Job Objects are unavailable. It does not need provider credentials or access a live API.

## CI and nightlies

CI runs on pushes to `main` and pull requests, with Bun 1.4.2 on Ubuntu, Windows and macOS. Each runner installs the frozen lockfile, runs `bun run check` (architecture, types, lint and tests), then builds and smoke-tests its native executable. Tests use the repository's isolated test home; live-test opt-ins are not enabled.

The nightly workflow runs daily at **18:00 UTC**, or manually from GitHub Actions. It checks `main` and skips when there are no commits since the previous nightly. After all three platforms pass the same checks, one runner cross-compiles all seven targets for channel `next`. Separate native runners verify archive checksums, extract archives and smoke-test Windows x64, Linux x64 (both including baseline), and macOS ARM64 without installing Bun. macOS x64 smoke is skipped because `macos-13` was retired in December 2025; Linux ARM64 currently has no native smoke runner.

Download nightlies from [GitHub Releases](https://github.com/CAMB-dev/Amira/releases). They are prereleases tagged `v<version>-nightly.<YYYYMMDD>`, with a numeric suffix if that tag already exists. Notes list commits since the previous nightly. Every release includes all archives and `SHA256SUMS`; assets are uploaded to a draft before it is published, and published releases are never overwritten or edited. Only the newest **14 nightly prereleases** are retained; older nightly releases and their tags are deleted, while non-nightly releases are untouched.

Signed manifests, install scripts, the npm wrapper and `amira update` are not part of this release batch.
