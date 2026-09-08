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

  it("keeps work-log row and detail geometry synchronous and base shimmer icons visible", () => {
    const source = ts.createSourceFile(
      "thread-work-log.tsx",
      readFileSync(new URL("./thread-work-log.tsx", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const layoutProps: ts.JsxAttribute[] = [];
    const fixedWorkRowProps: ts.JsxAttribute[] = [];
    const clippedWorkLabels: ts.JsxAttribute[] = [];
    const shimmerIcons: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "layout") {
        layoutProps.push(node);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "getFixedItemSize") {
        fixedWorkRowProps.push(node);
      }
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(source) === "numberOfLines" &&
        node.initializer?.getText(source) === "{1}"
      ) {
        clippedWorkLabels.push(node);
      }
      if (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(source) === "ShimmerWorkContent"
      ) {
        const icon = node.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "showIcon",
        );
        shimmerIcons.push(icon?.initializer?.getText(source) ?? "");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(layoutProps).toHaveLength(0);
    expect(fixedWorkRowProps).toHaveLength(0);
    expect(clippedWorkLabels).toHaveLength(0);
    expect(shimmerIcons).toEqual(["{props.showIcon}", "{props.showIcon}"]);
  });
});
