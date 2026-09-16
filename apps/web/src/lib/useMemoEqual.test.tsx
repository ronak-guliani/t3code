import { describe, expect, it } from "vitest";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { arraysRefEqual, useMemoEqual } from "./useMemoEqual";

describe("arraysRefEqual", () => {
  it("requires identical length and refs", () => {
    const item = { id: 1 };
    expect(arraysRefEqual([item], [item])).toBe(true);
    expect(arraysRefEqual([item], [{ id: 1 }])).toBe(false);
    expect(arraysRefEqual([item], [item, item])).toBe(false);
    expect(arraysRefEqual([], [])).toBe(true);
  });

  it("uses Object.is semantics for elements", () => {
    expect(arraysRefEqual([Number.NaN], [Number.NaN])).toBe(true);
    expect(arraysRefEqual([0], [-0])).toBe(false);
  });

  it("does not skip sparse holes", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(arraysRefEqual([,], [,])).toBe(true);
    // eslint-disable-next-line no-sparse-arrays
    expect(arraysRefEqual([,], [undefined])).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(arraysRefEqual([undefined], [,])).toBe(false);
  });
});

describe("useMemoEqual", () => {
  function Probe({
    items,
    turnId,
    factoryCalls,
  }: {
    items: ReadonlyArray<{ id: number }>;
    turnId: string | undefined;
    factoryCalls: { count: number };
  }) {
    const value = useMemoEqual(() => {
      factoryCalls.count += 1;
      return items.map((item) => item.id).join(",");
    }, [items, turnId]);
    return createElement("div", null, value);
  }

  function renderProbe(props: { items: { id: number }[]; turnId: string | undefined }) {
    const factoryCalls = { count: 0 };
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
      renderer = TestRenderer.create(createElement(Probe, { ...props, factoryCalls }));
    });
    return {
      factoryCalls,
      rerender(next: { items: { id: number }[]; turnId: string | undefined }) {
        act(() => {
          renderer!.update(createElement(Probe, { ...next, factoryCalls }));
        });
      },
      unmount() {
        act(() => {
          renderer!.unmount();
        });
      },
    };
  }

  it("reuses the value when array contents are ref-identical", () => {
    const item = { id: 1 };
    const probe = renderProbe({ items: [item], turnId: "turn-1" });
    try {
      // New array identity, same item refs: plain useMemo would recompute.
      probe.rerender({ items: [item], turnId: "turn-1" });
      expect(probe.factoryCalls.count).toBe(1);
    } finally {
      probe.unmount();
    }
  });

  it("recomputes when an item ref or scalar dep changes", () => {
    const item = { id: 1 };
    const nextItem = { id: 1 };
    const probe = renderProbe({ items: [item], turnId: "turn-1" });
    try {
      probe.rerender({ items: [nextItem], turnId: "turn-1" });
      expect(probe.factoryCalls.count).toBe(2);
      // Same item refs, new scalar: isolates the scalar path.
      probe.rerender({ items: [nextItem], turnId: "turn-2" });
      expect(probe.factoryCalls.count).toBe(3);
    } finally {
      probe.unmount();
    }
  });
});
