# Install

[Documentation](../README.md)

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

## GitHub Releases archives

Download the matching archive, `SHA256SUMS`, `manifest.json` and `manifest.json.sig` from the same [GitHub Release](https://github.com/CAMB-dev/Amira/releases). Prefer the x64 baseline archive for older CPUs. Extract it and put `amira` (`amira.exe` on Windows) on your PATH. No Node.js or Bun installation is required to run the extracted executable.

Before extracting, check the archive's SHA-256 against `SHA256SUMS`. On Linux, with all release archives in the current directory:

```sh
sha256sum --check SHA256SUMS
```

For a single downloaded archive, check its entry only. On macOS use `shasum -a 256 <archive>`; on Windows use `Get-FileHash <archive> -Algorithm SHA256` in PowerShell and compare the result to that entry. Checksums detect corruption, not an attacker who can replace both files.

Stable and release-candidate releases also include an Ed25519-signed manifest with the version, channel, archive names, byte sizes and SHA-256 digests. Verify the signature with a public key obtained through a trusted channel, then compare the archive's size and digest to the signed entry. Do not trust a public key supplied alongside an untrusted download. See the sign script's commands below. The public key is not embedded in Amira yet; that belongs to the later self-update batch. Existing nightly releases contain checksums but no signed manifest.

## Maintainer setup (once)

1. Create an npm account and reserve/configure all six packages: `amira`, `amira-win32-x64`, `amira-linux-x64`, `amira-linux-arm64`, `amira-darwin-x64` and `amira-darwin-arm64`. Configure a trusted publisher for this repository's `release.yml` workflow on **each** package. Initial publication may require an npm token before trusted publishing can be configured.
2. If trusted publishing is unavailable, add a narrowly scoped npm publishing token as the repository Actions secret `NPM_TOKEN`. Do not store it in the repository or pass it to local verification commands. The publish job requests OIDC and uses npm provenance.
3. Generate an Ed25519 key pair with the sign script. Store the private **PKCS8 PEM** as the Actions secret `AMIRA_RELEASE_ED25519_KEY`; keep an offline backup. The command prints the public key: record it through a trusted channel for release verification. A future self-update batch will embed the public key in Amira. Never commit the private key.
4. Enable **immutable releases** in the repository's release settings. The workflow uploads every asset to a draft, then publishes once. It never edits a published release.
5. Before publishing, enable a repository tag ruleset for **`v*`**, excluding `v*-nightly.*` so nightly retention can still prune its tags, that blocks updates and deletions with no bypass for release actors. The workflow checks that the remote tag's peeled commit still matches the checked commit immediately before creating and publishing a release. The ruleset is required to prevent a tag move between that check and publication.

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

Use `workflow_dispatch` on the release tag with `dry-run` enabled first. It builds, checks, signs and runs `npm publish --dry-run`, but does not create a release or publish packages. No nightly is published to npm. See [building Amira](building.md) for local build commands. Self-update and install scripts are not implemented in this batch.
