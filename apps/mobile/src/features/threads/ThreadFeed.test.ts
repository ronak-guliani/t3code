import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

describe("ThreadFeed native positioning", () => {
  it("leaves virtual cell geometry with the list rather than native layout animations", () => {
    // Node cannot reproduce Reanimated's stale UIKit frames. Guard the integration
    // that caused gaps/overlaps after text resizing and work-group disclosures.
    const source = ts.createSourceFile(
      "ThreadFeed.tsx",
      readFileSync(new URL("./ThreadFeed.tsx", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const lists: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === "KeyboardAwareLegendList"
      ) {
        lists.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(lists).toHaveLength(1);
    const attributes = lists[0]!.attributes.properties
      .filter(ts.isJsxAttribute)
      .map((attribute) => attribute.name.getText(source));
    expect(attributes).not.toContain("itemLayoutAnimation");
    expect(attributes).toContain("getFixedItemSize");
    expect(attributes).toContain("maintainVisibleContentPosition");
    expect(attributes).toContain("maintainScrollAtEnd");
  });
});
