/** Fixed POSIX sh programs. All variable data arrives as quoted positional arguments or raw stdin. */
export const PROBE_SCRIPT = `set -eu
home=$(cd -P "$HOME" && pwd -P)
root="\${home%/}/.amira/remote"
for cmd in uname id getconf sha256sum mktemp stat cat wc chmod mkdir mv ln rmdir rm grep tr; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done
[ -w "$home" ] && [ -x "$home" ] || { echo 'Home must be writable and searchable' >&2; exit 1; }
cpu=unknown
case "$(uname -m)" in
  x86_64) if grep -qw sse4_2 /proc/cpuinfo; then cpu=baseline; fi ;;
  aarch64|arm64) cpu=arm64 ;;
esac
installed=''
installed_hash=''
if [ -x "$root/bin/amira-server" ]; then
  installed=$("$root/bin/amira-server" --version-json) || installed=''
  actual=$(sha256sum "$root/bin/amira-server") || actual=''
  installed_hash=\${actual%% *}
fi
printf '%s\\000' "$(uname -s)" "$(uname -m)" "$home" "$(id -un)" "$(id -u)" "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)" "$cpu" "$installed" "$installed_hash"
`

export const INSTALL_SCRIPT = `set -eu
umask 077
root=$1
artifact=$2
target=$3
expected_hash=$4
expected_size=$5
expected_version=$6
home=$(cd -P "$HOME" && pwd -P)
[ "$root" = "\${home%/}/.amira/remote" ] || { echo 'Remote home changed; approve setup again' >&2; exit 1; }
uid=$(id -u)
owned_dir() {
  [ ! -L "$1" ] || { echo 'Refusing a symlinked install directory' >&2; exit 1; }
  if [ ! -e "$1" ]; then mkdir -m 700 "$1"; fi
  [ -d "$1" ] && [ "$(stat -c %u "$1")" = "$uid" ] || { echo 'Install directory must belong to the SSH user' >&2; exit 1; }
  mode=$(stat -c %a "$1")
  case "$mode" in *[2367][0-7]|*[0-7][2367]) echo 'Install directory must not be writable by other users' >&2; exit 1 ;; esac
}
owned_dir "$home/.amira"
owned_dir "$root"
owned_dir "$root/bin"
owned_dir "$root/servers"
lock="$root/.install-lock"
mkdir -m 700 "$lock" || { echo 'Another installation is in progress; retry after it finishes' >&2; exit 1; }
stage=''
cleanup() {
  if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
  rmdir -- "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "$root/.upload.XXXXXXXXXX")
mkdir -m 700 "$stage/version"
binary="$stage/version/amira-server"
cat > "$binary"
[ "$(wc -c < "$binary" | tr -d '[:space:]')" = "$expected_size" ] || { echo 'Uploaded executable length mismatch' >&2; exit 1; }
actual=$(sha256sum "$binary")
[ "\${actual%% *}" = "$expected_hash" ] || { echo 'Uploaded executable SHA-256 mismatch' >&2; exit 1; }
chmod 700 "$binary"
[ "$("$binary" --version-json)" = "$expected_version" ] || { echo 'Uploaded executable build identity mismatch' >&2; exit 1; }
"$binary" --self-check > "$stage/self-check.json" || { echo 'Uploaded executable self-check failed' >&2; exit 1; }
# Authenticated executable content, not commit SHA: stable/nightly may share a commit.
owned_dir "$root/servers/$artifact"
dest="$root/servers/$artifact/$target"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  owned_dir "$dest"
  [ ! -L "$dest/amira-server" ] && [ -f "$dest/amira-server" ] || exit 1
  [ "$(stat -c %u "$dest/amira-server")" = "$uid" ] || exit 1
  actual=$(sha256sum "$dest/amira-server")
  [ "\${actual%% *}" = "$expected_hash" ] || { echo 'Existing build differs from signed artifact' >&2; exit 1; }
  chmod 700 "$dest/amira-server"
  "$dest/amira-server" --self-check > "$stage/existing-check.json" || exit 1
else
  mv -T -- "$stage/version" "$dest"
fi
ln -s -- "$dest/amira-server" "$stage/launcher"
# Rename the launcher only after upload, identity and self-check succeed. Keep all previous builds.
mv -Tf -- "$stage/launcher" "$root/bin/amira-server"
printf '%s\\n' "$expected_version"
`

/** Cwd is intentionally absent. The client sends it in the protocol hello, never shell evaluation. */
export const ATTACH_SCRIPT = `set -eu
exec "$1" attach
`

/** Remote provider credentials are used only after explicit, saved model-mode consent. */
export const ATTACH_REMOTE_KEY_SCRIPT = `set -eu
exec "$1" attach --remote-key
`
