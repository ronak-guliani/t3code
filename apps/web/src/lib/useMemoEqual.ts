import { useRef } from "react";

/**
 * Element-wise reference equality for array deps. Full-length scan: same
 * length plus identical refs at every index means immutable data did not
 * change, so derived output can be reused without recomputation.
 */
export function arraysRefEqual(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
 * Plain useMemo keys on the dep _array identity_, so a parent that rebuilds
 * an array with identical item refs (the common streaming-chunk case)
 * invalidates every downstream derivation. This hook reuses the previous
 * value when the dep contents are ref-identical, which is sound for the
 * immutable store data flowing through the timeline: same refs imply same
 * data, so a pure factory returns an equal result. When anything actually
 * changes it recomputes, exactly like useMemo.
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
