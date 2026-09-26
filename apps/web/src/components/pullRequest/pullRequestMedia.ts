import { isWebUrl, nextMarkdownFence } from "./pullRequestMarkdownUtils";

export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: "markdown"; readonly text: string }
  | { readonly id: string; readonly kind: "video"; readonly url: string };

const VIDEO_TAG_MAX_LINES = 8;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;
const VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;
const BARE_VIDEO_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
const GITHUB_ATTACHMENT_PREFIX = "https://github.com/user-attachments/assets/";

function videoUrlFromLine(line: string): string | null {
  const url = BARE_VIDEO_URL_PATTERN.exec(line.trim())?.[1];
  if (
    url === undefined ||
    !isWebUrl(url) ||
    (!VIDEO_EXTENSION_PATTERN.test(url) && !url.startsWith(GITHUB_ATTACHMENT_PREFIX))
  ) {
    return null;
  }
  return url;
}

export function splitPullRequestBody(body: string): ReadonlyArray<PullRequestBodySegment> {
  const segments: PullRequestBodySegment[] = [];
  const segmentOccurrences = new Map<string, number>();
  const markdown: string[] = [];
  let openFence: string | null = null;
  const createSegmentId = (kind: PullRequestBodySegment["kind"], value: string) => {
    const base = `${kind}:${value}`;
    const occurrence = segmentOccurrences.get(base) ?? 0;
    segmentOccurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  };

  const flushMarkdown = () => {
    const text = markdown.join("\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
    markdown.length = 0;
    if (text.trim().length > 0) {
      segments.push({ id: createSegmentId("markdown", text), kind: "markdown", text });
    }
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextFence = nextMarkdownFence(openFence, line);
    if (nextFence !== openFence) {
      openFence = nextFence;
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    const bareVideoUrl = videoUrlFromLine(line);
    if (bareVideoUrl !== null) {
      flushMarkdown();
      segments.push({
        id: createSegmentId("video", bareVideoUrl),
        kind: "video",
        url: bareVideoUrl,
      });
      continue;
    }

    if (!VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    const lastCandidate = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1;
    let cursor = index;
    while (cursor < lastCandidate && !VIDEO_TAG_END_PATTERN.test(lines[cursor]!)) {
      cursor += 1;
    }
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor]!)
      ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).join("\n"))?.[1]
      : undefined;
    if (source !== undefined && isWebUrl(source)) {
      flushMarkdown();
      segments.push({ id: createSegmentId("video", source), kind: "video", url: source });
      index = cursor;
    } else {
      markdown.push(line);
    }
  }

  flushMarkdown();
  return segments;
}
