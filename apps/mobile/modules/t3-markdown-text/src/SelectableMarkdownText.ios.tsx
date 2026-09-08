import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownWithPreservedSoftBreaks,
  type NativeMarkdownDocumentChunk,
  type NativeMarkdownTextRun,
} from "./nativeMarkdownText";
import { MarkdownImageRendererContext, NativeMarkdownBlock } from "./NativeMarkdownBlock.ios";
import {
  MarkdownFileContextMenuContext,
  NativeMarkdownSelectableText,
  type MarkdownFileContextMenuHandlers,
} from "./NativeMarkdownSelectableText.ios";
import type {
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];

type PreparedMarkdownChunk =
  | (Extract<NativeMarkdownDocumentChunk, { kind: "selectable" }> & {
      readonly runs: ReadonlyArray<NativeMarkdownTextRun>;
    })
  | Extract<NativeMarkdownDocumentChunk, { kind: "rich" }>;

export type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  markdown,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  fileContextMenu,
  onFileContextMenuAction,
  renderImage,
  marginTop = 0,
  marginBottom = 0,
}: SelectableMarkdownTextProps) {
  const previousChunksRef = useRef<{
    readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
    readonly chunks: ReadonlyArray<PreparedMarkdownChunk>;
  } | null>(null);

  const chunks = useMemo(() => {
    const parsedDocument = parseMarkdownWithOptions(markdown, {
      gfm: true,
      html: true,
      math: false,
    });
    const document = preserveSoftBreaks
      ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
      : parsedDocument;
    const previous = previousChunksRef.current;
    const documentChunks = nativeMarkdownDocumentChunks(document, previous?.chunks);
    const nextChunks: ReadonlyArray<PreparedMarkdownChunk> = documentChunks.map((chunk, index) => {
      const previousChunk = previous?.chunks[index];
      if (previous?.skills === skills && previousChunk === chunk) {
        return previousChunk;
      }
      return chunk.kind === "selectable"
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk;
    });
    return nextChunks;
  }, [markdown, preserveSoftBreaks, skills]);

  useEffect(() => {
    previousChunksRef.current = { skills, chunks };
  }, [chunks, skills]);

  const fileContextMenuHandlers = useMemo<MarkdownFileContextMenuHandlers | null>(
    () =>
      fileContextMenu && onFileContextMenuAction
        ? { fileContextMenu, onFileContextMenuAction }
        : null,
    [fileContextMenu, onFileContextMenuAction],
  );

  return (
    <MarkdownImageRendererContext.Provider value={renderImage ?? null}>
      <MarkdownFileContextMenuContext.Provider value={fileContextMenuHandlers}>
        {/* A percentage width here creates a cyclic intrinsic measurement inside
          shrink-to-fit containers such as user-message bubbles. Yoga then gives
          the native text node an unbounded second pass and the parent only clips
          the resulting single-line width instead of reflowing it. */}
        <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
          {chunks.map((chunk, index) => {
            const content =
              chunk.kind === "rich" ? (
                <NativeMarkdownBlock
                  node={chunk.node}
                  skills={skills}
                  textStyle={textStyle}
                  highlightCode={highlightCode}
                  onLinkPress={onLinkPress}
                />
              ) : (
                <NativeMarkdownSelectableText
                  runs={chunk.runs}
                  textStyle={textStyle}
                  onLinkPress={onLinkPress}
                />
              );

            return (
              <View
                key={chunk.key}
                style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
              >
                {content}
              </View>
            );
          })}
        </View>
      </MarkdownFileContextMenuContext.Provider>
    </MarkdownImageRendererContext.Provider>
  );
}
