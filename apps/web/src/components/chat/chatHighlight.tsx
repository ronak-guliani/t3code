import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

const CHAT_FIND_HIGHLIGHT_CLASS_NAME =
  "rounded-sm bg-yellow-300/65 px-0.5 text-foreground shadow-[0_0_0_1px_rgba(202,138,4,0.25)] dark:bg-yellow-400/35";

export function normalizeChatHighlightQuery(query: string | undefined): string {
  return query?.trim() ?? "";
}

export function highlightPlainText(text: string, query: string | undefined): ReactNode {
  const normalizedQuery = normalizeChatHighlightQuery(query);
  if (normalizedQuery.length === 0) {
    return text;
  }

  const normalizedText = text.toLocaleLowerCase();
  const normalizedNeedle = normalizedQuery.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = normalizedText.indexOf(normalizedNeedle, cursor);
    if (matchIndex === -1) {
      break;
    }

    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }

    const matchEnd = matchIndex + normalizedNeedle.length;
    parts.push(
      <mark
        key={`chat-find-highlight:${matchIndex}:${matchEnd}`}
        className={CHAT_FIND_HIGHLIGHT_CLASS_NAME}
      >
        {text.slice(matchIndex, matchEnd)}
      </mark>,
    );
    cursor = matchEnd;
  }

  if (parts.length === 0) {
    return text;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts;
}

export function highlightReactText(node: ReactNode, query: string | undefined): ReactNode {
  const normalizedQuery = normalizeChatHighlightQuery(query);
  if (normalizedQuery.length === 0) {
    return node;
  }
  return highlightReactNode(node, normalizedQuery);
}

function highlightReactNode(node: ReactNode, query: string): ReactNode {
  if (typeof node === "string") {
    return highlightPlainText(node, query);
  }

  if (typeof node === "number") {
    return highlightPlainText(String(node), query);
  }

  if (Array.isArray(node)) {
    return Children.map(node, (child) => highlightReactNode(child, query));
  }

  if (!isValidElement<{ children?: ReactNode }>(node) || node.props.children === undefined) {
    return node;
  }

  return cloneElement(node as ReactElement<{ children?: ReactNode }>, {
    children: highlightReactNode(node.props.children, query),
  });
}
