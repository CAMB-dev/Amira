#!/bin/sh
# Install a self-managed GitHub Releases build. Configuration remains in ~/.amira.
set -eu

version=
channel=stable
releases=https://github.com/CAMB-dev/Amira/releases
public_key='' # AMIRA_RELEASE_PUBLIC_KEY
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--channel)
      flag=$1
      [ "$#" -ge 2 ] || { echo "Missing value for $flag" >&2; exit 1; }
      case "$flag" in --version) version=${2#v} ;; --channel) channel=$2 ;; esac
      shift 2 ;;
    --help) echo 'Usage: install.sh [--version X.Y.Z] [--channel stable|next]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$channel" in stable|next) ;; *) echo 'Channel must be stable or next' >&2; exit 1 ;; esac
valid_version() {
  [ "$1" = "$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\037\177')" ] &&
    printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$'
}
if [ -n "$version" ]; then
  valid_version "$version" || { echo 'Invalid version' >&2; exit 1; }
fi
# JSON paths may contain spaces, quotes and backslashes, but not control characters.
if [ "$HOME" != "$(printf '%s' "$HOME" | LC_ALL=C tr -d '\001-\037\177')" ]; then
  echo 'HOME must not contain control characters' >&2; exit 1
fi
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo 'Use install.ps1 on Windows' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
target=bun-$os-$arch
# Baseline builds work on x64 CPUs without AVX2.
if [ "$arch" = x64 ] && [ "$os" = linux ]; then target=$target-baseline; fi
root=$HOME/.local/share/amira
bin=$HOME/.local/bin/amira
mkdir -p "$root/versions" "$(dirname "$bin")"
lock=$root/update.lock
(set -C; printf '%s\n' "$$" > "$lock") 2>/dev/null || { echo 'Another Amira installation or update is in progress' >&2; exit 1; }
staging=$root/.staging.$$
retention_lock=$root/retention.lock
retention_owned=false
release_retention_gate() {
  if [ "$retention_owned" = true ]; then rm -f "$retention_lock"; retention_owned=false; fi
}
cleanup() { rm -rf "$staging"; release_retention_gate; rm -f "$lock"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$staging"
base=$releases/latest/download
if [ "$channel" = next ]; then base=https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next; fi
if [ -n "$version" ]; then base=$releases/download/v$version; fi
fetch() { curl -q --fail --silent --show-error --location "$1" --output "$2"; }
fetch "$base/manifest.json" "$staging/manifest.json"
if [ -n "$public_key" ]; then
  if command -v openssl >/dev/null 2>&1 &&
     openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' &&
     openssl list -public-key-algorithms 2>/dev/null | grep -qi ED25519; then
    fetch "$base/manifest.json.sig" "$staging/signature.base64"
    printf '%s\n' "$public_key" > "$staging/public.pem"
    encoded=$(tr -d '\r\n' < "$staging/signature.base64")
    printf '%s\n' "$encoded" | grep -Eq '^[A-Za-z0-9+/]{86}==$' || { echo 'Invalid manifest signature' >&2; exit 1; }
    printf '%s' "$encoded" | openssl base64 -d -A -out "$staging/signature"
    openssl pkeyutl -verify -pubin -inkey "$staging/public.pem" -rawin -in "$staging/manifest.json" -sigfile "$staging/signature" >/dev/null || { echo 'Manifest signature verification failed' >&2; exit 1; }
  else
    echo 'Warning: OpenSSL Ed25519 verification is unavailable; checking SHA-256 only, not the manifest signature.' >&2
  fi
else
  echo 'Warning: no release public key is configured; checking SHA-256 only. Self-updates will be disabled.' >&2
fi
# The release generator writes one property per line. Read only tightly validated values.
manifest_version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$staging/manifest.json")
manifest_channel=$(sed -n 's/^  "channel": "\([^"]*\)",$/\1/p' "$staging/manifest.json")
valid_version "$manifest_version" || { echo 'Invalid manifest version' >&2; exit 1; }
[ -z "$version" ] || [ "$version" = "$manifest_version" ] || { echo 'Manifest version mismatch' >&2; exit 1; }
[ "$channel" = "$manifest_channel" ] || { echo 'Manifest channel mismatch' >&2; exit 1; }
version=$manifest_version
case "$channel:$version" in stable:*-*) echo 'Stable manifest contains a prerelease version' >&2; exit 1 ;; esac
archive=amira-$target.tar.gz
entry=$(awk -v target="$target" '
  /"target":/ { selected = ($2 == "\"" target "\","); if (selected) count++ }
  selected && /"file":/ { gsub(/[",]/, "", $2); file=$2 }
  selected && /"size":/ { gsub(/,/, "", $2); size=$2 }
  selected && /"sha256":/ { gsub(/[",]/, "", $2); sha=$2 }
  END { if (count == 1) print file, size, sha }
' "$staging/manifest.json")
# Every component is constrained before splitting the one manifest entry.
manifest_file=${entry%% *}
remainder=${entry#* }
size=${remainder%% *}
sha=${remainder#* }
[ "$manifest_file" = "$archive" ] && printf '%s\n' "$size" | grep -Eq '^[1-9][0-9]{0,8}$' &&
  [ "$size" -le 536870912 ] && printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$' || { echo 'No valid manifest entry for this platform' >&2; exit 1; }
fetch "$releases/download/v$version/$archive" "$staging/archive.tar.gz"
[ "$(wc -c < "$staging/archive.tar.gz" | tr -d '[:space:]')" = "$size" ] || { echo 'Archive size mismatch' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum < "$staging/archive.tar.gz" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 < "$staging/archive.tar.gz" | cut -d ' ' -f 1)
fi
[ "$actual" = "$sha" ] || { echo 'Archive SHA-256 mismatch' >&2; exit 1; }
# Extract exactly the executable, not arbitrary archive paths.
mkdir "$staging/version"
[ "$(tar -tzf "$staging/archive.tar.gz")" = amira ] || { echo 'Archive must contain only the executable' >&2; exit 1; }
tar -xzf "$staging/archive.tar.gz" -C "$staging/version" amira
[ -f "$staging/version/amira" ] && [ ! -L "$staging/version/amira" ] || { echo 'Invalid executable in archive' >&2; exit 1; }
chmod 755 "$staging/version/amira"
probed=$("$staging/version/amira" --version)
[ "${probed%% *}" = "$version" ] || { echo 'Executable version mismatch' >&2; exit 1; }
# Retention gate: only local validation, version publication, activation and pruning are guarded.
take_retention_gate() {
  attempts=0
  until (set -C; printf '%s\n' "$$" > "$retention_lock") 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 25 ] || { echo 'Amira version retention is busy; try again' >&2; return 1; }
    sleep 0.01
  done
  retention_owned=true
}
take_retention_gate
# Never overwrite a version which another running process may still use.
if [ -e "$root/versions/$version" ]; then
  cmp -s "$staging/version/amira" "$root/versions/$version/amira" || { echo 'Existing version differs; refusing to overwrite it' >&2; exit 1; }
else
  mv "$staging/version" "$root/versions/$version"
fi
json_bin=$(printf '%s' "$bin" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"kind":"single-file","version":"%s","channel":"%s","target":"%s","bin":"%s"}\n' "$version" "$channel" "$target" "$json_bin" > "$staging/install.json"
ln -s "$root/versions/$version/amira" "$staging/amira-link"
# staging and ~/.local/bin are on the same home volume in the supported layout.
[ ! -d "$bin" ] || { echo 'The executable path is a directory' >&2; exit 1; }
[ ! -d "$root/install.json" ] || { echo 'The install marker path is a directory' >&2; exit 1; }
had_bin=false
if [ -e "$bin" ] || [ -L "$bin" ]; then
  cp -P "$bin" "$staging/previous-bin"
  had_bin=true
fi
mv -f "$staging/amira-link" "$bin"
if ! mv -f "$staging/install.json" "$root/install.json"; then
  if [ "$had_bin" = true ]; then mv -f "$staging/previous-bin" "$bin"; else rm -f "$bin"; fi
  echo 'Could not save install marker; restored the previous executable' >&2; exit 1
fi
# Session leases share the updater's leases/<version>/<unique>.lease protocol.
# Unknown owners, unreadable records and unexpected layouts always retain versions.
lease_layout_safe=true
lease_root=$root/leases
if [ -e "$lease_root" ] || [ -L "$lease_root" ]; then
  if [ ! -d "$lease_root" ] || [ -L "$lease_root" ] || [ ! -r "$lease_root" ] || [ ! -x "$lease_root" ]; then lease_layout_safe=false; fi
  ls -A "$lease_root" >/dev/null 2>&1 || lease_layout_safe=false
  for lease_directory in "$lease_root"/* "$lease_root"/.[!.]* "$lease_root"/..?*; do
    [ -e "$lease_directory" ] || [ -L "$lease_directory" ] || continue
    if [ ! -d "$lease_directory" ] || [ -L "$lease_directory" ] || ! valid_version "${lease_directory##*/}"; then
      lease_layout_safe=false
    fi
  done
fi
lease_host=$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]') || lease_host=
version_in_use() {
  [ "$lease_layout_safe" = true ] && [ -n "$lease_host" ] || return 0
  lease_directory=$lease_root/$1
  [ -d "$lease_directory" ] || return 1
  [ -r "$lease_directory" ] && [ -x "$lease_directory" ] || return 0
  ls -A "$lease_directory" >/dev/null 2>&1 || return 0
  for lease_file in "$lease_directory"/* "$lease_directory"/.[!.]* "$lease_directory"/..?*; do
    [ -e "$lease_file" ] || [ -L "$lease_file" ] || continue
    [ -f "$lease_file" ] && [ ! -L "$lease_file" ] || return 0
    case "$lease_file" in *.lease) ;; *) return 0 ;; esac
    extra=
    { IFS= read -r header && IFS= read -r owner_host && IFS= read -r owner_pid &&
      IFS= read -r owner_version && ! IFS= read -r extra; } < "$lease_file" || return 0
    [ -z "$extra" ] && [ "$header" = amira-version-lease-v1 ] &&
      [ "$owner_host" = "$lease_host" ] && [ "$owner_version" = "$1" ] || return 0
    case "$owner_pid" in ''|*[!0-9]*|0*) return 0 ;; esac
    if kill -0 "$owner_pid" 2>/dev/null; then return 0; fi
    # kill cannot distinguish ESRCH from EPERM. Only an empty, error-free ps lookup
    # proves absence; permission errors and an unavailable ps retain the version.
    command -v ps >/dev/null 2>&1 || return 0
    if ps -p "$owner_pid" -o pid= > "$staging/lease-pid" 2> "$staging/lease-pid-error"; then return 0; fi
    [ ! -s "$staging/lease-pid" ] && [ ! -s "$staging/lease-pid-error" ] || return 0
    rm -f "$lease_file" || return 0
  done
  return 1
}
# The normal three versions plus any live-session versions are retained.
kept=0
ls -1t "$root/versions" | while IFS= read -r directory; do
  valid_version "$directory" || continue
  [ -d "$root/versions/$directory" ] && [ ! -L "$root/versions/$directory" ] || continue
  [ "$directory" = "$version" ] && continue
  kept=$((kept + 1))
  if [ "$kept" -gt 2 ] && ! version_in_use "$directory"; then rm -rf "$root/versions/$directory"; fi
done
release_retention_gate
printf 'Installed Amira %s (%s).\n' "$version" "$channel"
case ":$PATH:" in *":$(dirname "$bin"):"*) ;; *) printf 'Add %s to PATH, then open a new terminal.\n' "$(dirname "$bin")" ;; esac
