# Shared synthesis guidance

Both `to-prd` and `to-spec` synthesize the current conversation and repository context rather than conducting a broad interview.

- Preserve decisions already made in the conversation.
- Ask only about an unresolved consequential choice that changes the output, scope, safety boundary, or delivery.
- If a choice is non-consequential, choose the smallest coherent default and record it.
- Keep output-specific differences in the calling skill: PRDs enter normal triage with `needs-triage`; specs use `ready-for-agent` and may include a decision-rich prototype snippet.
- Before publishing, verify the tracker configuration and report any unsupported integration instead of inventing one.
