import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Tests must not depend on the shell that runs them. They decide colors, the terminal and
// Amira's settings themselves (passing `color`, an `env` or a home where it matters).

// A NO_COLOR or FORCE_COLOR would change what the TUI draws.
delete process.env.NO_COLOR
delete process.env.FORCE_COLOR

// What tells terminals apart: in Windows Terminal, say, WT_SESSION turns on the progress
// indicator (OSC 9;4, ended by a BEL) and changes the keys, links and images offered.
for (const name of [
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "COLORFGBG",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "ConEmuPID",
  "ConEmuANSI",
  "VTE_VERSION",
  "KITTY_WINDOW_ID",
  "WEZTERM_EXECUTABLE",
  "FORCE_HYPERLINK",
  "TMUX",
  "STY",
  "WSL_DISTRO_NAME",
  "VISUAL",
  "EDITOR",
]) {
  delete process.env[name]
}

// Amira's own variables (AMIRA_MODEL, AMIRA_BASH, ...) and its user directory: without this,
// anything left to default reads the real ~/.amira (settings, AGENTS.md, keybindings,
// providers). Each run gets an empty one; tests that need a particular home still set theirs.
// AMIRA_LIVE_* stay: they turn on the live tests, which are skipped without them.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("AMIRA_") && !name.startsWith("AMIRA_LIVE_")) delete process.env[name]
}
const home = mkdtempSync(path.join(os.tmpdir(), "amira-test-home-"))
process.env.AMIRA_HOME = home
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})
