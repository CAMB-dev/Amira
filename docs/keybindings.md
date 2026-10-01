# Keybindings

Every key the interactive UI answers belongs to an action. To change keys, put a JSON object
in `~/.amira/keybindings.json` (or `$AMIRA_HOME/keybindings.json`) that maps action names to
a key or a list of keys:

```json
{
  "queue": "ctrl+b",
  "newline": ["shift+enter", "ctrl+j"],
  "redraw": []
}
```

- A key replaces all of the action's default keys. An empty list unbinds the action.
- The first key of an action is the one the hint line shows (for `newline`, the first one the
  terminal can report).
- The hint line under the input shows only the few keys that matter now: `Enter send · ? keys`
  while idle (`Shift+Enter newline` in place of `? keys` once the input has text), and
  `Enter steer · Alt+Enter queue · Esc interrupt` while a turn runs (`Esc send queued` while
  steering or queued messages wait, and `Esc Esc rewind` where the session is stored). The lists, the history
  search, the find bar and a block selection show their own. `?` (the `help` action) opens the
  key reference: every action with the keys bound to it now and its name for this file.
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
| `submit` | `enter` | Send the message; while a turn runs, steer it (queue it with `tui.submitWhileWorking: "queue"`) |
| `newline` | `shift+enter`, `ctrl+enter` | Insert a line break |
| `queue` | `alt+enter`, `ctrl+q` (Windows, except in VS Code: `ctrl+q` first) | While a turn runs, send the message after it (steer it with `tui.submitWhileWorking: "queue"`) |
| `submit.steer` | none | Send the message; while a turn runs, always steer it |
| `submit.queue` | none | Send the message; while a turn runs, always send it after the turn |
| `interrupt` | `escape` | Cancel a running command, preserving the input; otherwise stop the running turn. With steering or queued messages waiting, they go out at once, merged into one message in the order they were typed. Pressed twice in a row (also while idle), it opens the rewind picker: your messages, newest first; the one picked and everything after it are cut from the conversation, and it goes back into the input to change and send again. Files are not restored |
| `cancel` | `ctrl+c` | Cancel a running command, preserving the input; otherwise stop the running turn (with steering or queued messages waiting, they go out as for `interrupt`), else clear the input, else quit |
| `exit` | `ctrl+d` | Quit when the input is empty and nothing runs |
| `redraw` | `ctrl+l` | Clear the screen and draw it again: the latest transcript and the input |
| `history.prev` | `up` | Recall the previous prompt (from the input's first line) |
| `history.next` | `down` | Recall the next prompt (from the input's last line) |
| `history.search` | `ctrl+r` | Search the prompt history |
| `tool-output` | `ctrl+o` | Cycle how much of tool results is shown (like `/verbose`) |
| `panels.toggle` | `ctrl+t` | Fold the live panels above the activity line (such as an extension's todo list) to one line each, or unfold them |
| `copy.reply` | `alt+c` | Copy the last reply of the session, as Markdown, to the clipboard (both modes) |
| `help` | `?` | Open the key reference, while the input is empty and no dialog or list is open (with text, `?` is typed). It scrolls with ↑↓, PgUp/PgDn, Home/End; Esc, `q` or `?` close it |
| `edit.kill-to-start` | `ctrl+u` | Cut from the start of the line to the caret (at the start, the line break before it) |
| `edit.kill-to-end` | `ctrl+k` | Cut from the caret to the end of the line (at the end, the line break after it) |
| `edit.kill-word` | `ctrl+w` | Cut the word before the caret |
| `edit.yank` | `ctrl+y` | Paste the text cut last; cuts in a row join into one. Folded pastes stay folded |
| `edit.undo` | `ctrl+z` | Undo the last change to the input: a word typed, a run of deletes, a cut, a paste, a recalled prompt |
| `edit.redo` | `ctrl+shift+z` | Redo the change undone last. Terminals without the kitty keyboard protocol send Ctrl+Shift+Z as Ctrl+Z; bind another key there |
| `edit.external` | `ctrl+g` | Edit the message in your editor: `$VISUAL`, else `$EDITOR` (a command, e.g. `code --wait`), else Notepad on Windows and vi elsewhere. The terminal is the editor's until it exits; the saved text becomes the input |

### Completion lists

The command popup, shown while the input starts with `/`; the skill popup, shown while it
starts with `$`; and the file list, shown while an `@word` is typed. Their keys come before
the input's. On a bare `/` or `$` no row is marked and Enter does nothing until one is picked
(the first ↓ marks the first row). In the skill popup, Enter runs the highlighted skill only
when it was picked or the typed name is the start of it; other text after a `$` (`$100 is the
price`) is sent as a message. A name nothing matches keeps the list open with
`no command matches /zzz`; a lone `$zzz` is then not sent until the list is closed with Esc.

| Action | Default | What it does |
| --- | --- | --- |
| `popup.up` | `up` | Select the previous command, skill, argument or file |
| `popup.down` | `down` | Select the next command, skill, argument or file |
| `popup.complete` | `tab` | Complete the selected command, skill or argument; insert the file |
| `popup.accept` | `enter` | Run the command or skill; insert the file |
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

Questions you answer inline: approvals and other confirmations, lists, diff reviews, text
input, and the model's questions (ask_user). Each is a block with a bar down its left, the
question, the options and the keys. In a list of up to nine options (not a confirmation), the
digit in front of an option chooses it, or checks it where several may be chosen. "Other…"
opens a text field in its row for an answer in your own words; there Enter keeps the text and
Esc closes the field (Esc again cancels the dialog). Several questions are asked one after
another in the same block and answered together: Enter goes on to the next question, and Esc
on a later question goes back to the one before, keeping the answers given.

Some lists are split into sections with keys of their own, shown in the hint line while an
option of that section is selected; such a key answers on the selected option. In the
`/agents` list, Enter on a sub-agent opens the live viewer on it and `p` prints its transcript
into the conversation instead; Enter on a worktree a sub-agent kept shows its diff, to merge,
keep or discard it.

In `/ext`, Enter manages an installed extension or installs one from the index; `d` shows
details of the selected extension. Typing filters the list; once a filter has text, `d` is
part of the filter. Install and update keep the input available and show a live progress
panel. Outside a dialog or completion list, Esc (`interrupt`) or Ctrl+C (`cancel`) cancels
the running command and preserves the draft; changes already completed stay installed.
The hint uses the current keybindings. Changes take effect with `/reload` while idle.

A confirmation (such as an approval) starts with nothing selected: Enter does nothing until
an option is picked with the arrows, so keys typed into a message just as it shows up cannot
answer it. There is no single key that says yes (`dialog.yes` is unbound unless you bind it).
Esc on an approval denies the call and stops the turn.

| Action | Default | What it does |
| --- | --- | --- |
| `dialog.up` | `up`, `shift+tab` | Select the previous option |
| `dialog.down` | `down`, `tab` | Select the next option |
| `dialog.choose` | `enter` | Choose the selected option, or submit the input |
| `dialog.cancel` | `escape`, `ctrl+c` | Cancel the dialog |
| `dialog.yes` | none | Answer yes to a confirmation at once |
| `dialog.no` | `n` | Answer no to a confirmation |
| `dialog.toggle` | `space` | Check or uncheck the selected option where several may be chosen |
| `dialog.prev-question` | `left` | Go back to the previous question of several |
| `dialog.next-question` | `right` | Go on to the next question of several, up to the first one not answered yet |

### Transcript (full-screen mode)

In full-screen mode (the default, see `tui.mode` below) Amira keeps the conversation and
scrolls it itself. These keys act on the transcript before the input gets them. Home, End and
plain characters act on the transcript only while the input is empty; otherwise the input
uses them. The mouse wheel scrolls three rows a notch, and dragging selects text (see
[Text selection](#text-selection)); a click does nothing else, so the keyboard stays with the
input. Blocks are selected with the keyboard (`select.start`). In inline mode the terminal
keeps the scrollback: the first press of `find`, a page key or `select.start` says they are
for full-screen mode, and the terminal's own scrollback and find work there.

The view follows the newest output. Scrolled up, it stays where it is while the conversation
grows, and the row under it says how many rows are below (`↓ 124 rows below`, or
`↓ new output · 124 rows below` once more has come); scrolling to the end (or End) follows
again.

| Action | Default | What it does |
| --- | --- | --- |
| `scroll.up` | `shift+up` | Scroll up a line |
| `scroll.down` | `shift+down` | Scroll down a line |
| `scroll.page-up` | `pageup` | Scroll up a page |
| `scroll.page-down` | `pagedown` | Scroll down a page |
| `scroll.top` | `ctrl+home`, `home`, `alt+home` (VS Code: `alt+home` first) | Go to the start of the conversation |
| `scroll.bottom` | `ctrl+end`, `end`, `alt+end` (VS Code: `alt+end` first) | Go to the end and follow it again |
| `select.start` | `ctrl+up`, `alt+up` (VS Code: `alt+up` first) | Select the newest block (a message, a reply, a tool call, a notice) |
| `find` | `ctrl+f`, `alt+f` (VS Code: `alt+f` first) | Open the find bar |

### Block selection

While a block is selected its first column is marked (`▌` where it is blank, the character
there in inverse video otherwise; the block keeps its width, so nothing moves) and the row
above the input says what it is and where: `reply 3 of 9`. Selecting a block that is partly
in view does not scroll. Typing and pasting go back to the input; keys the selection does not
use (Ctrl+C, Ctrl+O, Ctrl+D) do what they do in the input.

`select.open` goes into a reply with code blocks: the first code block is selected, `↑`/`↓`
move between the reply's code blocks, `select.copy` copies the one selected (its code as
written, without the frame), and `select.back` or Esc go back to the whole reply. A folded
reply unfolds first, so its code shows whole. On a tool call with sub-agents (or a block of
background sub-agents) `select.open` opens the sub-agent viewer on the one still running, else
the latest; `←`/`→` there switch between them.

| Action | Default | What it does |
| --- | --- | --- |
| `select.prev` | `up`, `ctrl+up`, `alt+up`, `k` | Select the block before |
| `select.next` | `down`, `ctrl+down`, `alt+down`, `j` | Select the block after |
| `select.toggle` | `enter`, `space` | Fold or unfold it: a tool call's output (and its sub-agents), long code blocks and `<details>` in a reply |
| `select.copy` | `y`, `c` | Copy the block (or the selected code block) to the clipboard |
| `select.open` | `right`, `o` | Go into a reply's code blocks; open the sub-agent viewer on a call's sub-agents |
| `select.back` | `left` | Go back from a code block to its whole reply |
| `select.exit` | `escape` | Stop selecting (from a code block: back to its reply) |

`tool-output` (Ctrl+O) sets how much of every tool call shows; a call folded or unfolded by
hand keeps its own level.

### Text selection

In full-screen mode Amira selects text with the mouse itself. Drag with the left button to
select: the selection is marked across rows and blocks, and when the button is released it is
copied to the clipboard (OSC 52, see [Copying](#copying)) and the hint row says how many
characters were copied. A double click selects a word (letters, digits and the characters of
paths and URLs), a triple click a line. Held below the last row of the transcript, or on its
top row after it was lower, the drag scrolls the transcript, faster the longer it is held.

What is copied is the text as shown, without the transcript's own marks: the `›` in front of
your messages, the indent of replies, the bars of quotes, the `●`, `└` and tree symbols of
tool calls and sub-agents, and the frame of code blocks. Code copies as written: its
indentation kept, a line wrapped over several rows as one line, and tabs kept when the whole
line is selected. An image copies as its alt text. Other text copies row by row, as wrapped
on screen, list bullets and links as they show. A very large selection (over about 100,000
characters) may be more than the terminal takes; the note says so.

The selection stays while the conversation goes on below it and while scrolling. A click
clears it, and so do sending a message, a change to a block it covers (a tool call finishing,
folding, another tool output level) and a resize (the text flows differently). Typing still
goes to the input.

| Action | Default | What it does |
| --- | --- | --- |
| `text.clear` | `escape` | Clear the selection. With text selected Esc does this before anything else (closing a list, the find bar or the history search, stopping a turn), except answering a dialog |

Holding Shift while dragging still selects with the terminal's own selection instead (see
[Copying](#copying)): a way out when OSC 52 does not reach the clipboard.

### Find

The find bar searches the text of the whole transcript as you type, and again as the
conversation goes on. It ignores case unless the text has capitals. Text wrapped over rows
is found as one line (a row break counts as a space), so what matches does not depend on the
width. Matches are highlighted, the current one also underlined; the bar says which one of
how many it is. It starts from the newest match. `/clear` and `/resume` start the transcript
afresh: find, copying and the exit printout see only the session shown.

| Action | Default | What it does |
| --- | --- | --- |
| `find.next` | `enter`, `up`, `f3` | Go to the next match up (older) |
| `find.prev` | `shift+enter`, `down`, `shift+f3` | Go to the next match down (newer) |
| `find.close` | `escape`, `ctrl+c`, `ctrl+g` | Close the find bar, staying at the match |

### Copying

The copy keys send the text to the clipboard with OSC 52, which Windows Terminal, VS Code,
iTerm2, kitty, WezTerm and others accept (tmux only with `set-clipboard on`); nothing tells
Amira whether it arrived. Mouse reporting is on in full-screen mode, and a drag selects text
the way [Text selection](#text-selection) says. For the terminal's own selection instead hold
Shift while dragging (Windows Terminal, VS Code on Windows and Linux, xterm); in VS Code on
macOS hold Option, or set `terminal.integrated.macOptionClickForcesSelection`.
The same goes for pasting with the mouse: in Windows Terminal hold Shift while right-clicking
(on Linux terminals, Shift+middle-click), or press Ctrl+V; Amira says so when a click with
those buttons reaches it. In inline mode the terminal's own selection and paste work as usual.

VS Code keeps Ctrl+F, Ctrl+Home, Ctrl+End and Ctrl+↑↓ for its terminal (they are in its
`terminal.integrated.commandsToSkipShell`), so there Alt+F, Alt+Home, Alt+End and Alt+↑ come
first and the key reference (`?`) lists them first.

Editing keys inside the input (arrows, Home/End, Ctrl+A/Ctrl+E, word moves and deletes) and
the keys of the `/agents` list (`p` prints the selected sub-agent) and of its viewer (←/→ and
Tab switch, `x` stops, `p` closes it and prints a snapshot of the one shown, `q`/Esc close) are
fixed for now.

## Terminal settings

These live under `tui` in `settings.json`, the user's or a project's (`.amira/settings.json`, which wins):

| Setting | Default | What it does |
| --- | --- | --- |
| `tui.mode` | `"fullscreen"` | `"fullscreen"` draws on the alternate screen: Amira scrolls, finds, folds and copies the conversation, redraws all of it when the window changes size, and prints it to the normal screen when it exits (also after a crash). `"inline"` leaves finished output in the terminal's own scrollback, for SSH, tmux, or native scrolling and selection. The `--inline` and `--fullscreen` flags win |
| `tui.title` | `true` | Set the terminal title to `Amira · <folder> ⎇ <branch>`, marked with `●` while a turn runs; the previous title comes back on exit. The title bar draws it in the system's font, so `⎇` is safe there; the status in the input box's border leaves it out (Cascadia Code and Mono lack it) |
| `tui.progress` | `true` | Show a busy indicator on the tab and taskbar while a turn runs, and a paused one while a dialog waits (OSC 9;4: Windows Terminal, ConEmu, VS Code, Ghostty) |
| `tui.bell` | `true` | Ring the bell when a turn ends or a dialog opens while the terminal is in the background; where the terminal does not report focus, only after a turn of 15 seconds or more |
| `tui.reflow` | `"auto"` | Inline mode: `"off"` for terminals that do not re-wrap lines when they get narrower, so a resize does not erase the transcript above the input; `"auto"` and `"on"` assume they do |
| `tui.submitWhileWorking` | `"steer"` | What `submit` (Enter) does while a turn runs: `"steer"` sends the message into the running turn, `"queue"` sends it after the turn. The `queue` key does the other one, and the hint line says which (`Enter queue · Ctrl+Q steer`). Slash commands run at once either way |
| `tui.images` | `"auto"` | Draw images that stand on a line of their own in replies, with the optional `images` extension installed (`amira ext install images`; it reads local files, and http(s) URLs with web_fetch's private-network protection, up to 10 MB): `"auto"` where the terminal says it can — Windows Terminal 1.22+ (Sixel), VS Code with `terminal.integrated.enableImages`, iTerm2, WezTerm, kitty, Ghostty; `"on"` everywhere; `"off"` never. Otherwise, and when an image fails or takes over 3 seconds, it shows as `🖼` and its alt text, linked to the image |
| `tui.shellOutputLines` | `3` | How many of its last output lines a shell command that succeeded shows under its result, as many as show while it runs; `0` shows none. A failed command shows its output's start and end, and the `full` tool output level (Ctrl+O) all of it |
