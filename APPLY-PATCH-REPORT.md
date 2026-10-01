# Task C: apply_patch

Implemented in the isolated `codex-apply-patch` worktree. Changes are uncommitted; main was not integrated. No model APIs or API keys were used. Test fixtures and command logs use the OS temporary directory; no `~/.amira` access was performed.

## Grammar and Codex compatibility

The tool takes `{ "patch": "*** Begin Patch\n...\n*** End Patch" }`. It accepts Add File, Delete File, Update File, optional Move to immediately after Update File, multiple `@@` hunks, `@@ context` section anchors, and `*** End of File`. Added lines use `+`, removed lines `-`, and context lines a space. An Add File may be empty; nonempty additions end in LF. Empty envelopes succeed with no changed files. Windows CRLF patch transport is accepted.

The implementation was checked against these official Codex sources on 2026-09-30:

- [parser.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/parser.rs): envelope, operations and heredoc grammar.
- [streaming_parser.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/streaming_parser.rs): current parser leniencies and context tracking.
- [seek_sequence.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/seek_sequence.rs): exact, trailing-whitespace, trimmed, and normalized punctuation/space matching passes.
- [file_update.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/file_update.rs): ordered source cursor, insertion-at-end and terminal empty context fallback.
- [lib.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/lib.rs): NormalizeToLf and PreserveLineEndings modes.

Hunks match original source positions in order and cannot overlap. Exact matches win over whitespace-fuzzy matches even if a fuzzy candidate occurs earlier. EOF anchoring only considers the source suffix. An `@@ context` line locates a section and advances past it; it is not a GNU numeric line range. Pure addition hunks append. Fuzzy context retains the actual source bytes, rather than replacing unchanged context with the model's spelling. Failure diagnostics include file, 1-based hunk, expected context, matching cursor, closest candidate line and its actual text.

Accepted common malformations deliberately mirror Codex's leniencies: outer whitespace; `<<EOF`, `<<'EOF'`, and `<<"EOF"` wrappers (including the upstream terminator ending-in-EOF check); an omitted first `@@`; bare empty context lines; and blank lines following an EOF marker. Trailing header whitespace is stripped. Code fences, prose outside an envelope, incomplete envelopes, unprefixed addition lines, empty update hunks, move-only updates, repeated empty `@@`, unknown markers, and GNU `\ No newline at end of file` are refused.

Intentional differences:

- Remote `*** Environment ID:` routing is rejected because this tool has one local workspace.
- An EOF marker requires a nonempty preceding hunk.
- Source LF/CRLF/mixed endings, BOM, UTF-8/UTF-16LE/UTF-16BE encoding, and original final-newline presence are always preserved. Codex's historical/default NormalizeToLf mode normalizes endings and supplies a final newline; its newer preserving mode is the closer comparison. Empty source files populated by a patch gain LF. Bare-CR source terminators are preserved too.
- Add refuses an existing file; move refuses an occupied destination. A path cannot be targeted twice or serve as both a file and an ancestor directory within a patch. This avoids ambiguous sequential operations in a validate-first transaction.
- The new tool is confined to the workspace and rejects symbolic links/junctions, hard-linked files, and unsafe Windows path aliases. Existing edit/write only resolve paths and can operate outside cwd; there was no existing containment check to reuse. Their behavior was left intact. `resolvePath`, `fileKey`, and `displayPath` are reused before stricter checks.
- Invalid UTF-8, malformed UTF-16 and binary updates are refused. Deletion can remove a binary file; its presenter marks the unavailable text diff as truncated.

## Transaction behavior

Every operation and hunk is prepared before any write or directory creation. Original bytes and file identity are captured, checked again before the commit starts, and checked immediately before each mutation. Existing files are opened and their identity and bytes verified before writing. The tool runs serially within a session. New files use exclusive creation; a failed exclusive open never makes an external file eligible for rollback. Move destinations request the source permission mode on creation (subject to the process umask on POSIX).

The rollback journal includes partially failed writes and reverses applied writes/deletes/adds plus directories created by this patch. Rollback deliberately ignores the abort signal so cancellation cannot interrupt restoration. Concurrent destination creation and later source modification are detected; earlier changes roll back while external changes remain. If a journaled path was concurrently replaced, rollback refuses to overwrite the replacement and reports the exact incomplete restoration.

Existing edit has no read-history guard, so there was no previous-read state to inherit. These protections cover changes during patch preparation/commit; they do not require an earlier read tool call.

Limits: multi-file changes are not a filesystem-level atomic visibility transaction or a crash-recovery protocol. Concurrent observers may see the commit in progress. Permanent disk errors may prevent rollback; they are reported as `Rollback incomplete`, never success. Node's portable pathname APIs cannot completely eliminate a malicious concurrent ancestor/junction swap between a path check and a filesystem operation. Static escape paths are rejected and snapshot/identity checks detect observed file changes, but race-free behavior against arbitrary concurrent writers is not guaranteed. This is not a hostile-process filesystem sandbox.

## Setting and user-facing behavior

```json
{
  "providers": {
    "openai": {
      "tools": { "edit": "edit" },
      "models": [
        { "id": "my-gpt-model", "tools": { "edit": "apply_patch" } },
        { "id": "my-other-model", "tools": { "edit": "both" } }
      ]
    }
  }
}
```

`providers.<id>.tools.edit` sets a provider default. `providers.<id>.models[].tools.edit` overrides it for an exact model ID. Values are `edit`, `apply_patch`, and `both`. Omission defaults to `edit`, preserving today's edit/write tool availability. `write` remains available in all modes. Explicit `tools.disabled` restrictions and subagent role allowlists still win. `defaultModel.tools` is deliberately unsupported; use the provider-level `tools` field. Existing settings merge behavior applies, including replacement of model arrays.

This is allowed in project settings because existing tool choices (`tools.disabled`) are already project-allowed. It does not change endpoints, credentials, trusted package loading, or other user-only fields. No model family is automatically opted in.

Filtering is per session/current model: preview, normal requests, native compaction, deferred tool descriptions, deferred search/loading and execution all use the same model decision. Switching models immediately recalculates availability without mutating the shared registry. Subagents inherit provider configuration and resolve their own model; their role restrictions remain intact. Builtin read/write/bash descriptions use tool-neutral language, so they do not direct a patch-only model to a missing edit tool. The existing system prompt contains no fixed edit-tool instructions.

`/tools` shows model-hidden editing tools as off. Trying to enable one reports the relevant provider/model `tools.edit` setting instead of claiming success. Allowed tools can still be disabled/re-enabled through normal controls.

The model receives an action/path list, including move origins and destinations. `ApplyPatchDetails.files` carries per-file diffs for the presenter, using the existing diff renderer and truncation rules. The presenter has a resume fallback based on the patch text. Agent activity includes every successfully changed path and move origin.

## Files changed

- New parser/applier and tool: `extensions/builtin-tools/src/patch-format.ts`, `extensions/builtin-tools/src/apply-patch.ts`.
- Tool registration, presenter, neutral descriptions: `extensions/builtin-tools/src/index.ts`, `presenters.ts`, `read.ts`, `write.ts`, `bash.ts`.
- New parser/corpus and tool/presenter/transaction tests: `extensions/builtin-tools/test/patch-format.test.ts`, `apply-patch.test.ts`; registration expectations in `index.test.ts`.
- Public contracts: `packages/api/src/settings.ts`, `tool-details.ts`.
- Settings schema and model filtering: `packages/core/src/config/schema.ts`, `agent.ts`, `deferred-tools.ts`, `subagents.ts`.
- Core tests: `packages/core/test/config.test.ts`, new `editing-tools.test.ts`.
- CLI wiring and tool status: `packages/cli/src/session.ts`, `control.ts`; new `packages/cli/test/editing-tools.test.ts`.
- Agent activity integration and role test: `extensions/agent/src/index.ts`, `test/agent.test.ts`.
- This report: `APPLY-PATCH-REPORT.md`.

## Validation

All test invocations clear inherited `AMIRA_LIVE_*` environment names without reading/printing their values. Bun 1.4.2, Windows PowerShell, and the supplied worktree dependencies were used.

- Parser/pure applier: 51 passed, 0 failed, 96 assertions. Includes 34 realistic model patch corpus fixtures, malformed acceptance/rejection, every operation, overlapping/ordered hunks, fuzzy context, EOF, LF/CRLF/mixed, empty and unterminated input.
- Filesystem/tool/presenter suite: 28 passed, 0 failed, 95 assertions. Covers all operations, UTF encodings/BOM, Unicode, Windows drive/backslash paths, directory/symlink/junction/hardlink escapes, stale later files, occupied add/move destinations, third-hunk prevalidation failure, partial third-write I/O rollback, move-delete failure rollback, concurrent replacement protection, invalid encodings, abort and mode preservation.
- Settings/config/deferred/native-search/CLI targeted suite: 55 passed, 0 failed; agent role/activity integration: 1 passed, 0 failed.
- Final CLI control plus core/CLI editing tests: 27 passed, 0 failed, 172 assertions.
- `bun run typecheck`: passed after integration. An earlier run caught only presenter-test detail typing, fixed before the successful run.
- `bunx biome check <changed paths>`: passed for all 23 changed TypeScript files. `git diff --check`: passed.
- Initial sandboxed `bun test extensions/builtin-tools`: 225 passed, 3 skipped, 2 failed, 805 assertions, 105.51 seconds. Failures were existing Windows shell tests (background-grandchild termination and Windows PowerShell 5.1 exotic cwd), also reproduced by the coordinator on untouched baseline. Added tests passed. Four later edge-case tests were subsequently added and pass in the 28-test targeted suite above.
- Final elevated `bun run check`: exit 0. Typecheck and repository-wide Biome passed, followed by 2013 passed, 10 skipped, 0 failed, 135464 assertions; 2023 tests across 176 files in 355.46 seconds. The live API tests stayed skipped. Log: OS-temp `amira-task-c-check.log`.
- Final elevated `bun test extensions/builtin-tools`: exit 0; 233 passed, 1 skipped, 0 failed, 822 assertions; 234 tests across 16 files in 89.47 seconds. Both initial shell failures pass outside the sandbox. Log: OS-temp `amira-task-c-builtin-elevated.log`.

The new behavior tests require exports/schema/runtime decisions absent in baseline and assert those directly. A destructive baseline reversal was not performed, and a full red/green baseline run of only the new tests is not claimed.

## Maintainer decisions remaining

Which model IDs, if any, should receive patch tooling by default is intentionally deferred. This change provides opt-in configuration only. If crash-atomic multi-file durability or protection against hostile concurrent directory manipulation is required, it needs a separate platform-specific filesystem transaction/sandbox design.
