const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function nextMarkdownFence(openFence: string | null, line: string): string | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (match === null) return openFence;
  const fence = match[1]!;
  const closes =
    openFence !== null &&
    fence[0] === openFence[0] &&
    fence.length >= openFence.length &&
    match[2]!.trim().length === 0;
  return openFence === null ? fence : closes ? null : openFence;
}

export function splitFencedCodeBlocks(body: string): string[] {
  const segments: string[] = [];
  let currentSegment = "";
  let openFence: string | null = null;

  for (const line of body.split(/(?<=\n)/u)) {
    const nextFence = nextMarkdownFence(openFence, line.replace(/\r?\n$/u, ""));
    if (openFence === null && nextFence !== null) {
      segments.push(currentSegment);
      currentSegment = line;
      openFence = nextFence;
      continue;
    }

    currentSegment += line;
    if (openFence !== null && nextFence === null) {
      segments.push(currentSegment);
      currentSegment = "";
    }
    openFence = nextFence;
  }

  segments.push(currentSegment);
  return segments;
}
