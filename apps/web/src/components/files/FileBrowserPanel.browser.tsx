import "../../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const entriesFixture = [
  { path: ".agents", kind: "directory" as const },
  { path: ".agents/skills", kind: "directory" as const },
  { path: ".agents/skills/ask-matt", kind: "directory" as const },
  { path: ".agents/skills/ask-matt/SKILL.md", kind: "file" as const },
  { path: ".agents/skills/creation-examples", kind: "directory" as const },
  { path: ".agents/skills/creation-examples/SKILL.md", kind: "file" as const },
  { path: "src", kind: "directory" as const },
  { path: "src/index.ts", kind: "file" as const },
];

vi.mock("./projectFilesQueryState", () => ({
  useProjectEntriesQuery: vi.fn(() => ({
    data: { entries: entriesFixture, truncated: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })),
  useProjectFileQuery: vi.fn(() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })),
}));

import FileBrowserPanel from "./FileBrowserPanel";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

function treeRow(): { shadow: ShadowRoot; rows: HTMLButtonElement[] } | null {
  const host = [...document.querySelectorAll("*")].find(
    (element) => element.shadowRoot?.querySelector("[data-file-tree-search-container]") != null,
  );
  if (!host?.shadowRoot) return null;
  const rows = [
    ...host.shadowRoot.querySelectorAll('button[data-type="item"]'),
  ] as HTMLButtonElement[];
  return { shadow: host.shadowRoot, rows };
}

function treeRowPaths(): string[] {
  const tree = treeRow();
  if (!tree) return [];
  return tree.rows.map((row) => row.getAttribute("data-item-path") ?? "");
}

describe("FileBrowserPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("filters the tree down to matches plus their ancestor chain", async () => {
    const screen = await render(
      <div style={{ height: 400, width: 700, overflow: "hidden" }}>
        <div className="flex h-full min-h-0 flex-col">
          <FileBrowserPanel
            environmentId={threadRef.environmentId}
            cwd="/repo/project"
            projectName="t3code"
            selectedPath={null}
            revealRequest={null}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      await vi.waitFor(
        () => {
          expect(treeRowPaths()).toContain("src/index.ts");
        },
        { timeout: 10000 },
      );

      await page.getByRole("textbox", { name: "Filter workspace files" }).fill("creation-");

      await vi.waitFor(
        () => {
          const paths = treeRowPaths();
          // The match itself is visible…
          expect(paths.some((path) => path.includes("creation-examples"))).toBe(true);
          // …alongside its ancestor chain for context…
          expect(paths.some((path) => path.startsWith(".agents/skills"))).toBe(true);
          // …while unrelated branches leave the view entirely.
          expect(paths.some((path) => path.startsWith("src"))).toBe(false);
        },
        { timeout: 10000 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
