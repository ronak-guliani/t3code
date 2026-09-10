---
name: virtualized-list-state
description: Keeps React and React Native virtualized lists correct when external state changes row rendering. Use when editing FlatList, FlashList, Legend List, renderItem callbacks, extraData, memoized rows, or custom item equality.
---

# Virtualized List State

## Core rule

Put every render-affecting per-row primitive in the list item model. Prefer:

```ts
{ thread, status: "completed", selected: false }
```

over passing global maps through closures, row props, or `extraData`.

## Workflow

1. List every value that can change visible row output.
2. Derive per-row values before rendering.
3. Include those values in custom item equality.
4. Reserve `extraData` for truly list-global presentation state.
5. Keep `renderItem` dependencies complete, but do not use dependency arrays as the primary invalidation model.
6. Add a transition test that keeps the entity reference stable, changes the external state, and proves the resulting item is unequal and renders the new state.

## Review checklist

- Does a persisted receipt, selection, permission, or environment value affect the row?
- Is its derived primitive present on the item?
- Does `itemsAreEqual` compare it?
- Do legacy, current, compact, and sidebar consumers use the same projection?
- Does the test cover `before -> state change -> after`, not only separately constructed snapshots?
