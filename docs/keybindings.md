# Keybindings

Every key the interactive UI answers belongs to an action. To change keys, put a JSON object
in `~/.amira/keybindings.json` (or `$AMIRA_HOME/keybindings.json`) that maps action names to
a key or a list of keys:

```json
{
  "queue": "ctrl+t",
  "newline": ["shift+enter", "ctrl+j"],
  "redraw": []
}
```

- A key replaces all of the action's default keys. An empty list unbinds the action.
- The first key of an action is the one the hint line shows (for `newline`, the first one the
  terminal can report).
- The file is read at startup. Unknown actions, keys that cannot be read and a key bound to two
  actions in the same place are reported as warnings when Amira starts; the rest of the file
  still applies. If the file is not valid JSON, the default keys are used.

## Key specs

A key spec is modifiers and a key joined with `+`, in any case: `ctrl+q`, `alt+enter`,
`shift+tab`, `escape`, `y`.

- Modifiers: `ctrl`, `alt` (also `option`, `meta`) and `shift`.
- Keys: `enter`, `tab`, `escape` (`esc`), `backspace`, `delete`, `insert`, `space`, `up`,
  `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1` to `f12`, or a single
  character. `ctrl++` is Ctrl and the plus key.
- A plain character matches with or without Shift (`y` also matches `Y`). Named keys and
  shortcuts match Shift exactly: `enter` is not `shift+enter`.

Some keys only reach Amira in some terminals. Shift+Enter needs a terminal that reports it
(Windows Terminal, VS Code, and others with the kitty keyboard protocol); elsewhere Ctrl+Enter
is the newline key. A terminal or editor may also keep a key for itself: Windows Terminal
takes Alt+Enter (fullscreen), and VS Code takes Ctrl+Q (Quick Open View) unless it is removed
from `terminal.integrated.commandsToSkipShell`.

## Actions

### Input

| Action | Default | What it does |
| --- | --- | --- |
| `submit` | `enter` | Send the message; while a turn runs, steer it |
| `newline` | `shift+enter`, `ctrl+enter` | Insert a line break |
| `queue` | `alt+enter`, `ctrl+q` (Windows, except in VS Code: `ctrl+q` first) | While a turn runs, send the message after it |
| `interrupt` | `escape` | Stop the running turn |
| `cancel` | `ctrl+c` | Stop the running turn, else clear the input, else quit |
| `exit` | `ctrl+d` | Quit when the input is empty and nothing runs |
| `redraw` | `ctrl+l` | Clear the screen and draw it again: the latest transcript and the input |
| `history.prev` | `up` | Recall the previous prompt (from the input's first line) |
| `history.next` | `down` | Recall the next prompt (from the input's last line) |
| `history.search` | `ctrl+r` | Search the prompt history |
| `tool-output` | `ctrl+o` | Cycle how much of tool results is shown (like `/verbose`) |

### Completion lists

The command popup, shown while the input starts with `/`, and the file list, shown while an
`@word` is typed. Their keys come before the input's.

| Action | Default | What it does |
| --- | --- | --- |
| `popup.up` | `up` | Select the previous command, argument or file |
| `popup.down` | `down` | Select the next command, argument or file |
| `popup.complete` | `tab` | Complete the selected command or argument; insert the file |
| `popup.accept` | `enter` | Run the command; insert the file |
| `popup.close` | `escape` | Close the list until the text changes |

### History search

While the history search runs, typing narrows it; other keys (such as the arrows) end it with
the match in the input and then do what they do.

| Action | Default | What it does |
| --- | --- | --- |
| `search.older` | `ctrl+r` | Show the next older match |
| `search.newer` | `ctrl+s` | Show the next newer match |
| `search.accept` | `enter` | Keep the match in the input to edit or send |
| `search.cancel` | `escape`, `ctrl+c`, `ctrl+g` | Leave the search with the draft back |

### Dialogs

Questions from extensions and commands: confirmations, lists, diff reviews and text input.
In a list of up to nine options, the digit in front of an option chooses it.

| Action | Default | What it does |
| --- | --- | --- |
| `dialog.up` | `up`, `shift+tab` | Select the previous option |
| `dialog.down` | `down`, `tab` | Select the next option |
| `dialog.choose` | `enter` | Choose the selected option, or submit the input |
| `dialog.cancel` | `escape`, `ctrl+c` | Cancel the dialog |
| `dialog.yes` | `y` | Answer yes to a confirmation |
| `dialog.no` | `n` | Answer no to a confirmation |

Editing keys inside the input (arrows, Home/End, Ctrl+A/Ctrl+E, word moves and deletes) and
the keys of the `/agents` viewer (←/→ and Tab switch, `x` stops, `q`/Esc close) are fixed for
now.

## Terminal settings

These live under `tui` in `settings.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `tui.title` | `true` | Set the terminal title to `Amira · <folder> ⎇ <branch>`, marked with `●` while a turn runs; the previous title comes back on exit |
| `tui.progress` | `true` | Show a busy indicator on the tab and taskbar while a turn runs, and a paused one while a dialog waits (OSC 9;4: Windows Terminal, ConEmu, VS Code, Ghostty) |
| `tui.bell` | `true` | Ring the bell when a turn ends or a dialog opens while the terminal is in the background; where the terminal does not report focus, only after a turn of 15 seconds or more |
| `tui.reflow` | `"auto"` | `"off"` for terminals that do not re-wrap lines when they get narrower, so a resize does not erase the transcript above the input; `"auto"` and `"on"` assume they do |
