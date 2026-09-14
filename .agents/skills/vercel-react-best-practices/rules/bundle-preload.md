---
title: Preload Based on User Intent
impact: MEDIUM
impactDescription: reduces perceived latency
tags: bundle, preload, user-intent, hover
---

## Preload Based on User Intent

Preload heavy bundles before they're needed to reduce perceived latency.

**Example (preload on hover/focus):**

```tsx
function EditorButton({ onClick }: { onClick: () => void }) {
  const preload = () => {
    if (typeof window !== "undefined") {
      void import("./monaco-editor");
    }
  };

  return (
    <button onMouseEnter={preload} onFocus={preload} onClick={onClick}>
      Open Editor
    </button>
  );
}
```

**Example (preload when feature flag is enabled):**

```tsx
function FlagsProvider({ children, flags }: Props) {
  useEffect(() => {
    if (flags.editorEnabled && typeof window !== "undefined") {
      void import("./monaco-editor").then((mod) => mod.init());
    }
  }, [flags.editorEnabled]);

  return <FlagsContext.Provider value={flags}>{children}</FlagsContext.Provider>;
}
```

The `typeof window !== 'undefined'` check prevents executing these imports on the server. It does not by itself exclude preloaded modules from the server bundle or file trace: a statically referenced dynamic import is still traced by the bundler. Bundle exclusion depends on the framework and bundler configuration (e.g. `ssr: false` dynamic imports), so do not rely on the guard alone for bundle-size reduction.
