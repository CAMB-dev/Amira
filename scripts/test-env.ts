// Tests decide colors themselves (they pass `color` or an env where it matters). A NO_COLOR or
// FORCE_COLOR in the shell that runs them would otherwise change what the TUI draws.
delete process.env.NO_COLOR
delete process.env.FORCE_COLOR
