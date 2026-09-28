/**
 * The paragraphs the shell tools add after a command's output, shared with the presenter so it
 * strips exactly these and never a paragraph the command printed itself.
 */
export const NOT_CONTAINED_WARNING =
  "Warning: the command could not be placed in a job object, so processes it started may still be running."
export const OUTPUT_OPEN_NOTE =
  "Note: output was still open after the command ended; some processes may still be running."

/** The status paragraph that follows the output: the exit code, or how the command stopped. */
export const STATUS_LINE =
  /^(Exit code: -?\d+|Command timed out after \d+ ms and was killed\.|Command was aborted\.|Command was killed by signal( \S+)?\.)$/
