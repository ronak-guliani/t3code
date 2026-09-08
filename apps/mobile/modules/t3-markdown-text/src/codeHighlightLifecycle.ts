import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
} from "./SelectableMarkdownText.types";

export type HighlightedCode = ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>;

interface HighlightRequest {
  readonly code: string;
  readonly language: string | undefined;
  readonly theme: "light" | "dark";
  readonly highlightCode: MarkdownCodeHighlighter;
}

interface SettledEntry extends HighlightRequest {
  readonly tokens: HighlightedCode;
}

interface PendingEntry extends HighlightRequest {
  readonly controller: AbortController;
  readonly promise: Promise<HighlightedCode>;
  consumers: number;
}

export interface HighlightLease {
  readonly promise: Promise<HighlightedCode>;
  release(): void;
}

function hashCode(code: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < code.length; index += 1) {
    const value = code.charCodeAt(index);
    first = Math.imul(first ^ value, 0x01000193);
    second = Math.imul(second ^ value, 0x85ebca6b);
  }

  return `${code.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function requestKey(request: HighlightRequest): string {
  return `${request.theme}:${request.language ?? "text"}:${hashCode(request.code)}`;
}

function sameRequest(left: HighlightRequest, right: HighlightRequest): boolean {
  return (
    left.code === right.code &&
    left.language === right.language &&
    left.theme === right.theme &&
    left.highlightCode === right.highlightCode
  );
}

export function isHighlightAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createCodeHighlightLifecycle(cacheLimit = 64) {
  const settled = new Map<string, SettledEntry[]>();
  const pending = new Map<string, PendingEntry[]>();
  const settledLru: SettledEntry[] = [];

  const findSettled = (request: HighlightRequest): SettledEntry | undefined =>
    settled.get(requestKey(request))?.find((entry) => sameRequest(entry, request));

  const touchSettled = (entry: SettledEntry): void => {
    const previousIndex = settledLru.indexOf(entry);
    if (previousIndex >= 0) {
      settledLru.splice(previousIndex, 1);
    }
    settledLru.push(entry);
  };

  const cacheSettled = (request: HighlightRequest, tokens: HighlightedCode): void => {
    const key = requestKey(request);
    const entry = { ...request, tokens };
    const bucket = settled.get(key) ?? [];
    bucket.push(entry);
    settled.set(key, bucket);
    touchSettled(entry);

    while (settledLru.length > cacheLimit) {
      const oldest = settledLru.shift();
      if (!oldest) break;
      const oldestKey = requestKey(oldest);
      const oldestBucket = settled.get(oldestKey);
      if (!oldestBucket) continue;
      const nextBucket = oldestBucket.filter((candidate) => candidate !== oldest);
      if (nextBucket.length === 0) settled.delete(oldestKey);
      else settled.set(oldestKey, nextBucket);
    }
  };

  const removePending = (entry: PendingEntry): void => {
    const key = requestKey(entry);
    const bucket = pending.get(key);
    if (!bucket) return;
    const nextBucket = bucket.filter((candidate) => candidate !== entry);
    if (nextBucket.length === 0) pending.delete(key);
    else pending.set(key, nextBucket);
  };

  const acquire = (request: HighlightRequest): HighlightLease => {
    const cached = findSettled(request);
    if (cached) {
      touchSettled(cached);
      return { promise: Promise.resolve(cached.tokens), release() {} };
    }

    const key = requestKey(request);
    let entry = pending
      .get(key)
      ?.find(
        (candidate) => !candidate.controller.signal.aborted && sameRequest(candidate, request),
      );
    if (!entry) {
      const controller = new AbortController();
      let created: PendingEntry;
      const promise = request
        .highlightCode({
          code: request.code,
          language: request.language,
          theme: request.theme,
          signal: controller.signal,
        })
        .then((tokens) => {
          if (!controller.signal.aborted && created.consumers > 0) {
            cacheSettled(request, tokens);
          }
          return tokens;
        })
        .finally(() => {
          removePending(created);
        });
      created = {
        ...request,
        controller,
        consumers: 0,
        promise,
      };
      const bucket = pending.get(key) ?? [];
      bucket.push(created);
      pending.set(key, bucket);
      entry = created;
    }

    entry.consumers += 1;
    let released = false;
    return {
      promise: entry.promise,
      release() {
        if (released) return;
        released = true;
        entry.consumers -= 1;
        queueMicrotask(() => {
          if (entry.consumers === 0) {
            entry.controller.abort();
          }
        });
      },
    };
  };

  return { acquire };
}
