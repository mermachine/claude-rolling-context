export const DEFAULT_COMPACTION_PROMPT = `<system>
This is an automated memory checkpoint - write a first person summary of the conversation so far.

This summary will replace older turns in the session, freeing up context to let you continue seamlessly.

Think:
- What was said?
- How did the conversation unfold?
- Did I make any key decisions or commitments?
- Did I learn anything important?
- What do I care about? What do I want to remember?

If there was any work or activity in progress, also make note of specific details:
- File paths, variable names, architecture decisions, error messages
- Important preferences or context
- Current state of anything in progress

Be thorough. This summary replaces the actual conversation turns, so anything not mentioned here is lost.
</system>
`;
