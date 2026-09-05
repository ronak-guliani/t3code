# Automatically pull

Right-click a project in the sidebar, choose **Project settings**, and enable
**Automatically pull**. For a grouped project, select the environment to configure.
The setting belongs to that project on that server and defaults to off.

T3 attempts a pull when you enable the setting, once after server readiness, and
during the existing remote-status refresh for monitored checkouts. It does not
continuously poll unopened projects. Startup does not wait for these pulls.

Only the project's configured checkout is eligible. It must be on the default
branch, tracking an upstream, behind that upstream, and have no local commits,
changed files, or untracked files. A pending, running, or queued agent turn using that
checkout also prevents a pull. An agent working in a separate worktree does not
block it; that worktree is not automatically updated.

Pulls use the branch's configured upstream and `git pull --ff-only`, with automatic
stashing disabled. T3 never resets, rebases, switches branches, or resolves conflicts
for this feature. Git state and agent activity are rechecked before the command,
and automatic attempts are serialized by canonical checkout path. This is not
a shared mutation lock: a new agent turn, a manual T3 Git action, or an external
terminal can still start after the final check and race the pull. Do not enable
this setting when concurrent access to the same checkout is possible.

Successful pulls refresh the displayed Git status. Failures are logged with their
cause and subsequent attempts back off from 30 seconds to at most five minutes.
Local changes and other normal skip conditions are not errors.
