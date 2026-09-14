import { CheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./dialog";

export function WizardPopup({
  children,
  ...props
}: Omit<ComponentProps<typeof DialogPopup>, "className" | "style">) {
  return (
    <DialogPopup {...props} className="max-w-xl overflow-x-hidden overflow-y-auto">
      <div className="flex min-h-0 flex-col">{children}</div>
    </DialogPopup>
  );
}

export function WizardHeader({
  title,
  description,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {description ? <DialogDescription>{description}</DialogDescription> : null}
      {children}
    </DialogHeader>
  );
}

export function WizardFooter({ children }: { readonly children: ReactNode }) {
  return <DialogFooter variant="bare">{children}</DialogFooter>;
}

export function WizardSteps({
  steps,
  currentStep,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  return (
    <ol className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted/50 p-1">
      {steps.map((step, index) => (
        <li key={step} className="min-w-0">
          <button
            type="button"
            disabled={isStepDisabled?.(index)}
            aria-current={index === currentStep ? "step" : undefined}
            onClick={() => onStepChange?.(index)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm",
              index === currentStep
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground",
            )}
          >
            <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-xs text-primary">
              {index < currentStep ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span className="truncate">{step}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function WizardPanel({ children }: { readonly children: ReactNode }) {
  return <div className="min-w-0 space-y-4 bg-muted/20 px-6 py-5">{children}</div>;
}
