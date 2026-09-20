import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

export function WorkspacePageHeader({ className, ...props }: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      className={cn(
        "flex h-12 min-h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5",
        className,
      )}
      {...props}
    />
  );
}
