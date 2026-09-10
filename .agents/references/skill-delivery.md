# Skill delivery boundaries

Use these terms consistently in implementation, PR, and delegation workflows. Resolve the requested delivery before taking side effects; explicit restrictions override defaults.

| Delivery                              | Authorized actions                                                                             | Stop before                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Investigation-only / description-only | Inspect relevant context and report findings or compose text                                   | Editing, staging, committing, pushing, or creating/updating a PR                                            |
| Implementation                        | Edit task-owned files and run required validation                                              | Committing or publication unless separately authorized by the request or applicable repository instructions |
| Commit                                | Stage and commit only task-owned changes after validation                                      | Pushing or creating/updating a PR unless publication is authorized                                          |
| Publication                           | Commit task-owned changes as needed, normal push, and create the requested ready-for-review PR | Merging, force-pushing, or changing unrelated PRs                                                           |

"Draft a PR description" requests text, not a GitHub draft PR. "Create a PR" authorizes publication and defaults to ready-for-review; use draft status only when explicitly requested.

"Prepare for review" alone does not authorize publication. Follow explicit implementation or commit instructions, otherwise inspect and report readiness without mutations. Ask only when a consequential ambiguity prevents safe progress.

Honor "leave uncommitted", "do not push", and investigation-only limits in every invoked skill and child prompt. Do not pass permission blocks beyond the authorized delivery. If requested publication conflicts with an explicit restriction, stop at the permitted boundary and report the conflict.

Report the actual delivery reached and any blocker. A successful commit is not a successful push or PR creation; a created PR with failed thread association still exists and must not be recreated.
