import {
  type EnvironmentId,
  type EditorId,
  type GitResolvedPullRequest,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, type ReactNode, useCallback } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { FileDownIcon, LoaderIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { SidebarCollapsedTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  AgentWorkflowHeaderActions,
  type AgentWorkflowHeaderAction,
  type AgentWorkflowRunRequest,
} from "./AgentWorkflowHeaderActions";
import { WorkflowRunsButton, type WorkflowRunPresentation } from "./WorkflowRunSummary";
import { EnvironmentIdentity } from "../EnvironmentIdentity";
import { ProjectEnvironmentNotice } from "../ProjectEnvironmentNotice";
import { useSettings } from "../../hooks/useSettings";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  exportingThread: boolean;
  exportThreadDisabledReason: string | null;
  gitCwd: string | null;
  workflowActions: ReadonlyArray<AgentWorkflowHeaderAction>;
  workflowRuns: ReadonlyArray<WorkflowRunPresentation>;
  onRunProjectScript: (script: ProjectScript) => void;
  onRunWorkflow: (request: AgentWorkflowRunRequest) => void;
  onListOpenPullRequests: () => Promise<ReadonlyArray<GitResolvedPullRequest>>;
  onPrewarmProviderSession: () => void;
  onPrewarmReviewPullRequest: (pullRequestNumber: number) => void;
  onNavigateThread: (threadId: ThreadId) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onExportThread: () => void;
  panelToggles?: ReactNode;
  paneActions?: ReactNode;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  exportingThread,
  exportThreadDisabledReason,
  gitCwd,
  workflowActions,
  workflowRuns,
  onRunProjectScript,
  onRunWorkflow,
  onListOpenPullRequests,
  onPrewarmProviderSession,
  onPrewarmReviewPullRequest,
  onNavigateThread,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  panelToggles,
  paneActions,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteEnvironment =
    primaryEnvironmentId !== null && activeThreadEnvironmentId !== primaryEnvironmentId;
  const headerShowProjectScripts = useSettings((s) => s.headerShowProjectScripts);
  const headerShowOpenIn = useSettings((s) => s.headerShowOpenIn);
  const headerShowGitActions = useSettings((s) => s.headerShowGitActions);
  const headerShowWorkflows = useSettings((s) => s.headerShowWorkflows);
  const headerShowWorkflowRuns = useSettings((s) => s.headerShowWorkflowRuns);
  const headerShowExportChat = useSettings((s) => s.headerShowExportChat);
  const headerExportConfirm = useSettings((s) => s.headerExportConfirm);
  const projectScriptsConfirmRun = useSettings((s) => s.projectScriptsConfirmRun);
  const gitConfirmDefaultBranch = useSettings((s) => s.gitConfirmDefaultBranch);
  const gitShowQuickAction = useSettings((s) => s.gitShowQuickAction);
  const workflowConfirmRun = useSettings((s) => s.workflowConfirmRun);
  const workflowPrewarmOnHover = useSettings((s) => s.workflowPrewarmOnHover);
  const workflowRunsShowBadge = useSettings((s) => s.workflowRunsShowBadge);
  const openInUpdatePreferred = useSettings((s) => s.openInUpdatePreferred);

  const handleRunProjectScript = useCallback(
    (script: ProjectScript) => {
      if (projectScriptsConfirmRun && !window.confirm(`Run "${script.name}"?`)) return;
      onRunProjectScript(script);
    },
    [onRunProjectScript, projectScriptsConfirmRun],
  );
  const handleRunWorkflow = useCallback(
    (request: AgentWorkflowRunRequest) => {
      if (workflowConfirmRun && !window.confirm("Run this workflow?")) return;
      onRunWorkflow(request);
    },
    [onRunWorkflow, workflowConfirmRun],
  );
  const handleExportThread = useCallback(() => {
    if (headerExportConfirm && !window.confirm("Export this chat?")) return;
    onExportThread();
  }, [headerExportConfirm, onExportThread]);
  const handlePrewarmProviderSession = useCallback(() => {
    // A confirmed workflow must not leak speculative work: the PR-review
    // click path captures before onRun fires, so canceling the confirm
    // would otherwise still launch the capture and consume its single-use
    // prewarm without the paired run.
    if (!workflowPrewarmOnHover || workflowConfirmRun) return;
    onPrewarmProviderSession();
  }, [onPrewarmProviderSession, workflowConfirmRun, workflowPrewarmOnHover]);
  const handlePrewarmReviewPullRequest = useCallback(
    (pullRequestNumber: number) => {
      if (!workflowPrewarmOnHover || workflowConfirmRun) return;
      onPrewarmReviewPullRequest(pullRequestNumber);
    },
    [onPrewarmReviewPullRequest, workflowConfirmRun, workflowPrewarmOnHover],
  );

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarCollapsedTrigger className="no-drag size-6 shrink-0" />
        <h2
          className="min-w-0 shrink truncate font-medium text-foreground"
          style={{ fontSize: "var(--app-chat-font-size)" }}
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        <EnvironmentIdentity environmentId={activeThreadEnvironmentId} />
        {activeProjectName ? (
          <ProjectEnvironmentNotice
            environmentId={activeThreadEnvironmentId}
            projectName={activeProjectName}
          />
        ) : null}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {activeProjectScripts && headerShowProjectScripts ? (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={handleRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}
        {activeProjectName && !isRemoteEnvironment && headerShowOpenIn ? (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
            updatePreferredOnSelect={openInUpdatePreferred}
          />
        ) : null}
        {activeProjectName && headerShowGitActions ? (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            confirmOnDefaultBranch={gitConfirmDefaultBranch}
            showQuickAction={gitShowQuickAction}
            {...(draftId ? { draftId } : {})}
          />
        ) : null}
        {headerShowWorkflows ? (
          <AgentWorkflowHeaderActions
            actions={workflowActions}
            onRun={handleRunWorkflow}
            onListOpenPullRequests={onListOpenPullRequests}
            onPrewarmProviderSession={handlePrewarmProviderSession}
            onPrewarmReviewPullRequest={handlePrewarmReviewPullRequest}
          />
        ) : null}
        {headerShowWorkflowRuns ? (
          <WorkflowRunsButton
            runs={workflowRuns}
            onNavigateThread={onNavigateThread}
            showBadge={workflowRunsShowBadge}
          />
        ) : null}
        {headerShowExportChat ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
                  variant="outline"
                  size="icon-xs"
                  onClick={handleExportThread}
                  aria-label="Export chat"
                  disabled={exportingThread || exportThreadDisabledReason !== null}
                >
                  {exportingThread ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <FileDownIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {exportThreadDisabledReason ??
                (exportingThread ? "Exporting chat..." : "Export chat")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {panelToggles}
        {paneActions}
      </div>
    </div>
  );
});
