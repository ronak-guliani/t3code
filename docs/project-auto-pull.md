# Automatically pull

Right-click a project in the sidebar, choose **Project settings**, and enable
**Automatically pull**. For a grouped project, select the environment to configure.
The setting belongs to that project on that server and defaults to off.

T3 attempts a pull when you enable the setting, once after server readiness, and
during the existing remote-status refresh for monitored checkouts. It does not
continuously poll unopened projects. Startup does not wait for these pulls.

Only the project's configured checkout is eligible. It must be on the default
branch, tracking an upstream, behind that upstream, and have no local commits,
changed files, or untracked files. A pending, running, queued, or finalizing agent
turn using that checkout also prevents a pull. An agent working in a separate worktree does not
block it; that worktree is not automatically updated.

Pulls use the branch's configured upstream and `git pull --ff-only`, with automatic
stashing disabled. T3 never resets, rebases, switches branches, or resolves conflicts
for this feature. Git state and agent activity are rechecked before the command,
and automatic attempts try to reserve the canonical checkout path. If a T3 Git
operation or turn admission already owns that reservation, the automatic attempt
skips. Foreground operations wait for a pull that has already started.

The process-local coordinator covers direct and queued turn admission through
the pending-state commit, checkpoint snapshots and restores, stacked Git actions,
PR checkout preparation, Git/VCS mutation RPCs, bootstrap worktree creation,
provider branch renames, and worktree cleanup. It does not hold a reservation for
an entire agent turn. The orchestration read model excludes pending/running/queued
turns, and an event-keyed completion exclusion bridges the idle session update to
the checkpoint worker's terminal outcome, including failure. Runtime session
checkouts remain excluded during handoff even after the thread's binding moves;
completion protects both the configured and runtime paths.

Checkout reservations never span orchestration dispatch or ingestion receipt
waits. Checkpoint capture locks its HEAD/worktree/index snapshot sequence and
releases before dispatching its result. Worktree setup and provider startup run
outside the reservation. Operations on separate worktrees use separate locks;
Git still owns locking of shared refs.

Interruption releases operation reservations. Completion exclusions are
process-local, so a server restart discards them rather than leaving stale locks;
the existing startup session reconciliation runs before automatic pulls start.
Interrupted checkpoint processing is not replayed by this coordinator.

External terminals, provider-spawned shell commands, and other server processes
do not acquire these locks. Agent shell work is excluded through its active turn,
but detached commands that outlive the turn are not covered. Do not enable this
setting when such concurrent access to the same checkout is possible.

Successful pulls refresh the displayed Git status. Failures are logged with their
cause and subsequent attempts back off from 30 seconds to at most five minutes.
Local changes and other normal skip conditions are not errors.
