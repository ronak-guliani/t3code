import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: ApprovalRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: ApprovalRequestId) => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = (questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  };
  const handleKeyboardOptionSelection = useEffectEvent(handleOptionSelection);

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleKeyboardOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isCollapsed, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const progressionHint =
    progress.customAnswer.trim().length > 0
      ? "Enter your own answer below, then use the action button."
      : activeQuestion.options.length === 0
        ? "Enter an answer below, then use the action button."
        : progress.isLastQuestion
          ? "Choose one option to submit automatically."
          : "Choose one option to continue automatically.";

  return (
    <div className="px-4 py-2 sm:px-5">
      <Collapsible
        open={!isCollapsed}
        onOpenChange={(open) => {
          setCollapsedQuestionId(open ? null : activeQuestion.id);
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={
              isCollapsed
                ? "Show the question and its options"
                : "Hide the question and its options"
            }
            title={
              isCollapsed
                ? "Show the question and its options"
                : "Hide the question and its options"
            }
            data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
          >
            {prompt.questions.length > 1 ? (
              <span className="flex h-5 shrink-0 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {questionIndex + 1}/{prompt.questions.length}
              </span>
            ) : null}
            <span className="shrink-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {activeQuestion.header}
            </span>
            {isCollapsed ? (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {activeQuestion.question}
              </span>
            ) : null}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                !isCollapsed && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          {prompt.dismissible ? (
            <button
              type="button"
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              data-pending-user-input-dismiss
              disabled={isResponding}
              onClick={() => onDismiss(prompt.requestId)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
        <CollapsiblePanel data-pending-user-input-panel>
          <div
            data-pending-user-input-content
            className="mt-1 max-h-[min(45vh,24rem)] overflow-y-auto overscroll-contain pb-2"
          >
            <p className="text-sm text-foreground">{activeQuestion.question}</p>
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {progress.isLastQuestion
                  ? "Select one or more options, then submit your answers."
                  : "Select one or more options, then choose Next."}
              </p>
            ) : (
              <p
                data-pending-user-input-progression-hint
                className="mt-1 text-xs text-muted-foreground"
              >
                {progressionHint}
              </p>
            )}
            <div className="mt-3 space-y-1">
              {activeQuestion.options.map((option, index) => {
                const isSelected = progress.selectedOptionLabels.includes(option.label);
                const shortcutKey = index < 9 ? index + 1 : null;
                return (
                  <button
                    key={`${activeQuestion.id}:${option.label}`}
                    type="button"
                    data-pending-user-input-option
                    disabled={isResponding}
                    onClick={() => handleOptionSelection(activeQuestion.id, option.label)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      isSelected
                        ? "border-blue-500/40 bg-blue-500/8 text-foreground"
                        : "border-transparent bg-muted/20 text-foreground hover:border-border/40 hover:bg-muted/40",
                      isResponding && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {shortcutKey !== null ? (
                      <kbd
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                          isSelected
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-muted/60 text-muted-foreground group-hover:bg-muted",
                        )}
                      >
                        {shortcutKey}
                      </kbd>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </div>
                    {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
});
