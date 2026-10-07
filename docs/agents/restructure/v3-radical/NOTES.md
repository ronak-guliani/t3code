# v3 radical — rationale

Most radical rung, and the only one that changes a file outside the proposal. `AGENTS.md` is 14 lines and 3 headings: a spine and a pointer list. Changes beyond the v2 set:

## Deleted outright (not moved)

- **`## Links in Responses`** — this deletion was **reversed** in the installed result and survives as spine step 4. The argument below held against dropping it: "use a Markdown link for a PR or issue" is a default, but linking a review comment to its permalink and labelling a cross-repo issue `owner/repo#123` are not. That is the residue that earns an always-loaded line.
- **`## Core Priorities`** — dropped as prose. "Performance first" and "Reliability first" name no observable bound and change no decision. The one clause that does change a decision (correctness over convenience, predictable under restarts) survives as step 3. The dropped words were already the repo's priorities; stating them changed nothing.
- **`## Keep This File Updated`** — folded into the `Any change` pointer, since `## Scars` above it named the same two files.

## Existing doc reshaped

- **This variant's `scars.md`** adds a sixth universal invariant, _reuse before you add_, which absorbs the whole `## Maintainability` section: extract shared logic instead of copying, change existing code when that is the honest fix, reject the narrow local shortcut. It belongs with the existing smallest-diff invariant because it is the same rule stated at two altitudes, and invariants are already the always-loaded tier — so the alternative was a second always-loaded home for one idea.

## Environment used as the source of truth

Toolchain literals dropped; `package.json` already answers. The nine `test-t3-app` bullets dropped in favour of a pointer. Validation commands are named once, in the spine, rather than repeated per branch.

## What this rung risks

Most of the always-loaded file is now a pointer list, so a pointer that fails to fire is a rule that silently stops applying. The `scars.md` edit also changes a file other agents and skills already point at, which is the most invasive move in any of the three variants and the first thing a reviewer should contest.
