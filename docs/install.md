# Install

[简体中文](zh/install.md) · [日本語](ja/install.md) · [Documentation](../README.md)

## Package managers

Choose one:

```sh
npm i -g amira
pnpm add -g amira
bun add -g amira
```

The npm and pnpm launcher runs on Node.js **18 or newer**. The executable includes its own runtime, so Bun is not required. Optional dependencies must be enabled: they contain the executable for your platform. Windows x64, Linux x64/ARM64 (glibc), and macOS x64/ARM64 are supported. Linux musl is not supported by these packages.

The `amira` package contains a small launcher and pins five optional platform packages to exactly its own version. `amira-win32-x64` and `amira-linux-x64` use the **baseline** builds for older CPUs without AVX2. The other packages use their matching native target. The launcher passes arguments, terminal streams and exit status through to the executable.

Run `amira --version` to see the version, channel, target and detected install source. Package-manager installs never self-update. To upgrade, run the command printed there (`npm i -g amira`, `pnpm add -g amira` or `bun add -g amira`). Detection uses the executable's path: pnpm's store/global directory and Bun's `.bun/install/global` directory identify those managers; other `node_modules` installs are reported as npm. Non-global Bun installs with an npm-compatible directory structure may therefore be reported as npm.

Release candidates use the `next` dist-tag, for example `npm i -g amira@next`. Nightlies are available only as GitHub Releases archives, not on npm.

## Single-file installer

Download and review the installer from a trusted release before running it. No Node.js or Bun runtime is needed.

macOS / Linux:

```sh
curl -fsSLO https://github.com/CAMB-dev/Amira/releases/latest/download/install.sh
sh install.sh --channel stable
# Pin a version: sh install.sh --version 1.2.3
# Try release candidates: sh install.sh --channel next
```

Windows (PowerShell):

```powershell
Invoke-WebRequest https://github.com/CAMB-dev/Amira/releases/latest/download/install.ps1 -OutFile install.ps1
./install.ps1 -Channel stable
# Pin a version: ./install.ps1 -Version 1.2.3
# Try release candidates: ./install.ps1 -Channel next
```

The installer compares the archive's SHA-256 and size with the manifest and verifies the manifest's Ed25519 signature when a trusted key and verification support are available. Without signature verification, checksums detect corruption but do not authenticate the publisher. The committed release public key is initially empty; installers warn about this, and Amira disables update checks until a maintainer embeds the key in a new build.

Windows installs versions under `%LOCALAPPDATA%\Amira\versions\<version>`, copies the active executable to `bin\amira.exe`, and adds that `bin` directory to your user PATH. Open a new terminal after installing. Unix installs versions under `~/.local/share/amira/versions/<version>` and links `~/.local/bin/amira` to the active version; add `~/.local/bin` to PATH if needed. An `install.json` marker identifies self-managed installs. Configuration, credentials and session data remain in `~/.amira`.

## Update and rollback

Only installer-managed single-file installs update themselves. Manually extracted archives, npm/pnpm/Bun packages, source runs, development builds and `0.0.0` versions do not. For package-manager installs, `amira update` prints the matching upgrade command instead. `amira rollback` is unavailable and exits with an error; select a version through your package manager.

```sh
amira update --check                # Check without installing
amira update                       # Install the selected channel's release
amira update --channel next         # Select release candidates for this command
amira rollback                     # Switch to the previous kept version
```

Background checks run at most once every 22 hours. Patch updates install silently and take effect on the next start; minor and major releases only show a notice. Update failures in the background are silent. Notices appear in the TUI notice strip, or on stderr for interactive print-mode use, never in machine-readable output. Amira normally retains three versions for rollback and cleans stale Windows `.old.<timestamp>.<pid>` executables at startup. Running versions are protected by session leases, so more than three versions may be kept until those sessions end. The installers honour the same leases. A running session continues using its original executable.

Set `updates.auto`, `updates.channel` and `updates.minimumVersion` in your **user** settings; project files cannot change update policy. A minimum version limits acceptable update and rollback targets without forcing a minor or major background upgrade. Rollback checks the floor under the update lock; there is no override flag. See the generated [settings reference](settings.md).

Environment switches (set to `1` to enable):

- `AMIRA_DISABLE_AUTOUPDATE`: disable background checks and downloads; explicit commands still work.
- `AMIRA_DISABLE_UPDATES`: disable update checks and installation, including `amira update`.
- `AMIRA_OFFLINE`: prevent update network requests, including startup checks.

An update lock serializes downloads and update writers. A separate short-lived retention gate coordinates lease registration, activation and pruning; it is not held during network requests. Startup briefly retries retention contention but never waits for another updater's downloads. Lease registration is best-effort: failures do not prevent a session from starting, and that session skips background update work and local pruning if protection cannot be established. If an interrupted process leaves a lock behind, first confirm that its owning Amira process or installer is no longer running before removing the stale lock in the install directory.

## GitHub Releases archives

Download the matching archive, `SHA256SUMS`, `manifest.json` and `manifest.json.sig` from the same [GitHub Release](https://github.com/CAMB-dev/Amira/releases). Prefer the x64 baseline archive for older CPUs. Extract it and put `amira` (`amira.exe` on Windows) on your PATH. No Node.js or Bun installation is required to run the extracted executable.

Before extracting, check the archive's SHA-256 against `SHA256SUMS`. On Linux, with all release archives in the current directory:

```sh
sha256sum --check SHA256SUMS
```

For a single downloaded archive, check its entry only. On macOS use `shasum -a 256 <archive>`; on Windows use `Get-FileHash <archive> -Algorithm SHA256` in PowerShell and compare the result to that entry. Checksums detect corruption, not an attacker who can replace both files.

Stable and release-candidate releases also include an Ed25519-signed manifest with the version, channel, archive names, byte sizes and SHA-256 digests. Verify the signature with a public key obtained through a trusted channel, then compare the archive's size and digest to the signed entry. Do not trust a public key supplied alongside an untrusted download. See the sign script's commands below. Amira embeds the trusted public key from `packages/cli/src/update/public-key.ts`; an empty key disables self-update checks. Existing nightly releases contain checksums but no signed manifest.

## Maintainer setup (once)

1. Create an npm account and reserve/configure all six packages: `amira`, `amira-win32-x64`, `amira-linux-x64`, `amira-linux-arm64`, `amira-darwin-x64` and `amira-darwin-arm64`. Configure a trusted publisher for this repository's `release.yml` workflow on **each** package. Initial publication may require an npm token before trusted publishing can be configured.
2. If trusted publishing is unavailable, add a narrowly scoped npm publishing token as the repository Actions secret `NPM_TOKEN`. Do not store it in the repository or pass it to local verification commands. The publish job requests OIDC and uses npm provenance.
3. Generate an Ed25519 key pair with the sign script. Store the private **PKCS8 PEM** as the Actions secret `AMIRA_RELEASE_ED25519_KEY`; keep an offline backup. The command prints the public key: record it through a trusted channel for release verification. Run `bun scripts/set-release-key.ts /secure/path/release-public.pem` to embed the **public** PEM before building. This validates an Ed25519 public key and changes only the committed public-key source; review and commit that public-key change separately. Never commit the private key.
4. Enable **immutable releases** in the repository's release settings. The workflow uploads every asset to a draft, then publishes once. It never edits a published release.
5. Before publishing, enable a repository tag ruleset for **`v*`**, excluding `v*-nightly.*` so nightly retention can still prune its tags, that blocks updates and deletions with no bypass for release actors. The workflow checks that the remote tag's peeled commit still matches the checked commit immediately before creating and publishing a release. The ruleset is required to prevent a tag move between that check and publication.

Before the first `next` publication, explicitly reserve its metadata branch with GitHub CLI authentication that can write repository contents:

```sh
bun scripts/publish-update-channel.ts bootstrap --repo CAMB-dev/Amira
```

This creates an owned `update-channels` branch containing only `.amira-update-channel.json`. It refuses to adopt any existing branch. If that name is already in use, inspect and migrate it separately; the release workflow will not overwrite it. Protect the branch against force pushes and deletion, while allowing the metadata job to append commits. Normal publication requires this ownership marker, rejects unexpected files or modes, and verifies both the candidate and existing signed manifest before comparing versions. Missing, invalid or untrusted metadata fails closed instead of being treated as a newer release.

CI reads the signing secret directly into memory and derives the public key there; it never writes a private key to disk. Dry runs without the secret generate an ephemeral key in memory. The file-based command below is only for local maintainer key generation.

Generate the private key outside the repository (the script refuses to overwrite a file), and save the printed public key as `release-public.pem`:

```sh
bun scripts/sign-manifest.ts keygen --key /secure/path/release-private.pem
```

After downloading release assets, verify the manifest signature with that trusted public key:

```sh
bun scripts/sign-manifest.ts verify --dist /path/to/downloads --public-key release-public.pem
```

This verification helper requires Bun in a source checkout; it is not needed to run Amira itself.

## Release checklist

Sync the CLI version and its `bun.lock` workspace entry before tagging (other workspace versions stay independent):

```sh
bun scripts/version-sync.ts bump patch       # Or minor, major, rc
bun scripts/version-sync.ts sync v1.2.3      # Or an explicit v1.2.3-rc.1
bun scripts/version-sync.ts check v1.2.3
```

Only `vX.Y.Z` and `vX.Y.Z-rc.N` are accepted. The tag must match `packages/cli/package.json`. Stable releases use channel `stable` and npm dist-tag `latest`; release candidates use channel `next` and dist-tag `next`.

The release workflow runs the full check gates, cross-compiles all seven targets and smoke-tests archives on Windows, Linux and macOS without installing Bun in the smoke jobs. macOS x64 and Linux ARM64 currently lack native smoke runners. It then signs the manifest, publishes the GitHub Release and publishes platform npm packages **before** the main package. Reruns skip npm versions already present.

Use `workflow_dispatch` on the release tag with `dry-run` enabled first. It builds, checks, signs and runs `npm publish --dry-run`, but does not create a release or publish packages. No nightly is published to npm. See [building Amira](building.md) for local build commands. Release assets include `install.sh` and `install.ps1`, staged with the same trusted public key as the binary. The `next` channel downloads signed metadata directly from `https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next/manifest.json` (and `.sig`), without the GitHub API. A serialized workflow advances this dedicated branch monotonically; allow the Actions token to update it. Archives always come from the immutable versioned release.
