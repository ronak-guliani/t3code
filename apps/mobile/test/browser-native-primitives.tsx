import type { ReactNode } from "react";

export function View({ children }: { readonly children?: ReactNode }) {
  return <div>{children}</div>;
}

export function ActivityIndicator() {
  return <div role="progressbar" aria-label="Loading screen" />;
}
