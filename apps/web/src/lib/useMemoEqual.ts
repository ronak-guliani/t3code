import { useRef } from "react";

/**
 * Element-wise reference equality for array deps. Every index is visited
 * explicitly with `Object.is` semantics (matching `useMemo` dep comparison):
 * unlike `===`, `-0` and `0` compare unequal and `NaN` compares equal, and
 * unlike `Array.prototype.every`, sparse holes are not skipped — a hole only
 * equals a hole at the same index. Full-length scan: same length plus
 * identical entries at every index means immutable data did not change, so
 * derived output can be reused without recomputation.
 */
export function arraysRefEqual(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftHas = index in left;
    if (leftHas !== index in right) {
      return false;
    }
    if (leftHas && !Object.is(left[index], right[index])) {
      return false;
    }
  }
  return true;
}

function depsEqual(prev: ReadonlyArray<unknown>, next: ReadonlyArray<unknown>): boolean {
  return (
    prev.length === next.length &&
    prev.every((dep, index) => {
      const nextDep = next[index];
      return Array.isArray(dep) && Array.isArray(nextDep)
        ? arraysRefEqual(dep, nextDep)
        : Object.is(dep, nextDep);
    })
  );
}

/**
 * useMemo with structural ref equality: array deps compare element-wise by
 * reference, other deps with Object.is.
 *
 * React's `useMemo` compares each dependency slot with `Object.is`, so a
 * slot holding a newly allocated array (e.g. the store rebuilding the
 * activities array on an unrelated streaming text chunk, with identical item
 * refs) invalidates every downstream derivation on every chunk. This hook
 * reuses the previous value when array dep contents are ref-identical, which
 * is sound for the immutable store data flowing through the timeline: same
 * refs imply same data, so a pure factory returns an equal result. When
 * anything actually changes it recomputes, exactly like useMemo.
 */
export function useMemoEqual<T>(factory: () => T, deps: ReadonlyArray<unknown>): T {
  const cache = useRef<{ deps: ReadonlyArray<unknown>; value: T } | null>(null);
  const prev = cache.current;
  if (prev !== null && depsEqual(prev.deps, deps)) {
    return prev.value;
  }
  const value = factory();
  cache.current = { deps, value };
  return value;
}
