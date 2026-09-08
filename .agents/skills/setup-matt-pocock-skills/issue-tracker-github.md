# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Use body links rather than assuming native GitHub dependency commands are configured:

- Ensure `wayfinder:map` and the needed `wayfinder:<type>` labels exist with `gh label list --search <label>` and `gh label create <label>` for missing labels. Preserve existing label settings.
- Create one map issue and separate decision issues. Each decision has exactly one type label and a `Parent map: #<number>` body line.
- Add one `Blocked by: #<number>` body line per dependency.
- Enumerate open issues with `gh api --paginate --method GET 'repos/{owner}/{repo}/issues' -f state=open -f per_page=100`, exclude pull requests, and filter by parent map. Do not treat the default limited issue list as complete.
- An unassigned child is available only if its map is open and every blocker is closed. Check blockers with `gh issue view <number> --json state`; unknown states remain blocked.
- Claim with `gh issue edit <number> --add-assignee @me` or the designated maintainer. Re-read assignees before work; assignment is not an atomic lock.
- Post the resolution as a comment, close the child, and add its title and link to the map's `Decisions so far`.
