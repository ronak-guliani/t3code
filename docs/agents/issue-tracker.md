# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` -- `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

This repository uses GitHub Issues, but no native blocking workflow is configured for the installed `gh` commands. Wayfinder maps and dependencies therefore use an explicit body convention:

- Ensure the `wayfinder:map` and needed `wayfinder:<type>` labels exist before creating issues. Use `gh label list --search <label>` and `gh label create <label>` for missing labels; do not overwrite existing label settings.
- Create the map as a GitHub issue labelled `wayfinder:map`.
- Create each decision ticket as a separate issue. Put `Parent map: #<map-number>` in its body and add exactly one `wayfinder:<type>` label.
- Record dependencies with one `Blocked by: #<issue-number>` line per blocking issue. Omit the line when the ticket is unblocked.
- Claim a ticket with `gh issue edit <number> --add-assignee @me`, or the designated maintainer's login. Re-read its assignees before working; assignment is coordination, not an atomic lock.
- Find all open children with `gh api --paginate --method GET 'repos/{owner}/{repo}/issues' -f state=open -f per_page=100`. Exclude pull requests, then inspect each issue's parent line, blockers, and assignees. Do not use the default limited `gh issue list` result as the complete frontier.
- A ticket is in the frontier only when its parent map is open, every listed blocker is closed, and it has no assignee. Read each blocker's state with `gh issue view <number> --json state`; inaccessible or unresolved references remain blocked.
- Record a resolution as a comment, close the ticket, and update the map's `Decisions so far` section with the ticket title and link.

Do not describe these body links as native GitHub dependency edges, and do not rely on a GitHub CLI subcommand that is not listed above.
