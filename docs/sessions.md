# Sessions

`/rename <title>` names the current session. Names appear in `/status`, `/resume`,
`amira -r` and the terminal title when `tui.title` is enabled. A manual name takes
precedence over an automatic name, including a naming request already in flight.

After a new session's first successful turn, Amira requests a short title in the
conversation's language in the background. It uses `compact.model` when set,
otherwise the current model, without tools or hosted search. The request's usage
is stored and included in `/cost`, `/status` and the tree's budget. Print mode and
sub-agents do not request titles. Set `"sessions": { "autoTitle": false }` in
user or project settings to disable it.

Type in `/resume` to search titles and user or assistant text, including later
messages and compacted history. Search uses case-insensitive substrings, so CJK
text needs no spaces. The matching text appears under the row. Press Ctrl+D to
delete the selected session, then confirm. The current session is excluded.
`amira sessions rm <id> [-C <dir>]` deletes a session from the command line.
Deletion removes referenced sub-agent files unless another session still uses
them. Attachments are stored inline in the session file. Paths that traverse
outside the session directory or through symlinks are refused.

`/fork` copies the current history into a new session and switches to it. The new
session records its parent and is named `<original title> (fork)`; unnamed
sessions use their id. The original file is unchanged. In the double-Esc rewind
picker, Enter rewinds and F forks from before the selected user message, putting
that message back in the editor. Compacted summary messages cannot be selected
as fork or rewind points.

RPC clients can use `session.rename` with `title`, and `session.fork` with an
optional user-message `index`. Forking emits `session.start` with reason `fork`;
renaming emits `session.title`. The protocol schema describes these operations
and the picker's search text.
