---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work before committing. Pass the relevant committed, staged, unstaged, and untracked WIP scope explicitly; an empty committed diff is not a reason to skip a non-empty WIP review. Apply review fixes, rerun affected checks, then commit only the task-owned changes.

Commit your work to the current branch.
