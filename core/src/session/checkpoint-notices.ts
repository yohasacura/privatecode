/**
 * The two notices the session appends after a checkpoint operation, as the fixed prefixes
 * `replay.ts` can match on.
 *
 * They live in their own module rather than in `session.ts` because the import only runs one
 * way: `session.ts` imports `replay.ts`, so `replay.ts` cannot import back. Same arrangement
 * as `OVERFLOW_RETRY_NOTE`, and for the same reason.
 *
 * Why they need matching at all: both are the HARNESS telling the model the disk moved under
 * it, and on resume `splitUserMessage` classified them as things the person typed — the caret
 * row showed "The workspace was rolled back to checkpoint cp-3 by the user" as a user message,
 * and `conversationAsMarkdown` exported it under "## You". A person did press the button; a
 * person did not write the sentence.
 */
export const REVERT_FILE_PREFIX = 'The user reverted '

/** See `REVERT_FILE_PREFIX`. */
export const ROLLBACK_PREFIX = 'The workspace was rolled back to checkpoint '
