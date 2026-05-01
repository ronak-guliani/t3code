import { type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface ChatFindRow {
  id: string;
  rowId: string;
  rowIndex: number;
  searchText: string;
}

export interface ChatFindMatch {
  id: string;
  rowId: string;
  rowIndex: number;
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectMessageSearchText(message: ChatMessage): string {
  const parts = [message.text ?? ""];

  for (const attachment of message.attachments ?? []) {
    parts.push(attachment.name);
  }

  return normalizeSearchText(parts.join("\n"));
}

function collectWorkEntrySearchText(entry: WorkLogEntry): string {
  const parts = [
    entry.label,
    entry.detail ?? "",
    entry.command ?? "",
    entry.rawCommand ?? "",
    entry.toolTitle ?? "",
    ...(entry.changedFiles ?? []),
  ];

  return normalizeSearchText(parts.join("\n"));
}

function collectProposedPlanSearchText(proposedPlan: ProposedPlan): string {
  return normalizeSearchText(proposedPlan.planMarkdown);
}

function buildChatFindRowFromTimelineRow(
  row: MessagesTimelineRow,
  rowIndex: number,
): ChatFindRow | null {
  switch (row.kind) {
    case "message": {
      const searchText = collectMessageSearchText(row.message);
      return searchText.length === 0
        ? null
        : {
            id: row.id,
            rowId: row.id,
            rowIndex,
            searchText,
          };
    }

    case "work": {
      const searchText = normalizeSearchText(
        row.groupedEntries.map((entry) => collectWorkEntrySearchText(entry)).join("\n"),
      );
      return searchText.length === 0
        ? null
        : {
            id: row.id,
            rowId: row.id,
            rowIndex,
            searchText,
          };
    }

    case "proposed-plan": {
      const searchText = collectProposedPlanSearchText(row.proposedPlan);
      return searchText.length === 0
        ? null
        : {
            id: row.id,
            rowId: row.id,
            rowIndex,
            searchText,
          };
    }

    case "working":
      return null;
  }
}

export function buildChatFindRows(rows: ReadonlyArray<MessagesTimelineRow>): ChatFindRow[] {
  return rows.flatMap((row, rowIndex) => {
    const nextRow = buildChatFindRowFromTimelineRow(row, rowIndex);
    return nextRow ? [nextRow] : [];
  });
}

export function findChatFindMatches(
  rows: ReadonlyArray<ChatFindRow>,
  query: string,
): ChatFindMatch[] {
  const normalizedQuery = normalizeSearchText(query).toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  return rows.flatMap((row) => {
    if (!row.searchText.toLocaleLowerCase().includes(normalizedQuery)) {
      return [];
    }

    return [
      {
        id: `${row.id}:${normalizedQuery}`,
        rowId: row.rowId,
        rowIndex: row.rowIndex,
      } satisfies ChatFindMatch,
    ];
  });
}
