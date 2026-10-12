import { afterAll } from "bun:test"
import { setClockPreference } from "../packages/tui/src/clock.ts"
import { isolateTestHome } from "./test-home"

// Capture the launching shell's homes before sanitizing any environment variables.
afterAll(isolateTestHome())

// Transcript assertions use a 24-hour clock regardless of the runner's Intl defaults.
setClockPreference({ locale: "en-GB", hourCycle: "h23" })

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

// Home isolation and AMIRA_* sanitization live in test-home.ts. AMIRA_LIVE_* stay:
// they turn on the live tests, which are skipped without them.
