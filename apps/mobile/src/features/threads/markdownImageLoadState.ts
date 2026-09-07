export const MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES = 2;

export interface MarkdownImageLoadState {
  readonly sourceKey: string;
  readonly uri: string | null;
  readonly failed: boolean;
  readonly automaticRetryCount: number;
  readonly requestVersion: number;
}

export interface MarkdownImageRequestIdentity {
  readonly sourceKey: string;
  readonly uri: string;
  readonly requestVersion: number;
}

export type MarkdownImageLoadEvent =
  | {
      readonly type: "source-changed";
      readonly sourceKey: string;
      readonly uri: string | null;
    }
  | { readonly type: "failed"; readonly request: MarkdownImageRequestIdentity }
  | { readonly type: "loaded"; readonly request: MarkdownImageRequestIdentity }
  | { readonly type: "retry"; readonly automatic: boolean };

export function createMarkdownImageLoadState(input: {
  readonly sourceKey: string;
  readonly uri: string | null;
}): MarkdownImageLoadState {
  return {
    sourceKey: input.sourceKey,
    uri: input.uri,
    failed: false,
    automaticRetryCount: 0,
    requestVersion: 0,
  };
}

export function createMarkdownImageRequestKey(input: {
  readonly sourceKey: string;
  readonly uri: string;
  readonly requestVersion: number;
}): string {
  return JSON.stringify([input.sourceKey, input.uri, input.requestVersion]);
}

export function isCurrentMarkdownImageRequest(
  state: Pick<MarkdownImageLoadState, "sourceKey" | "uri" | "requestVersion">,
  request: MarkdownImageRequestIdentity,
): boolean {
  return (
    state.sourceKey === request.sourceKey &&
    state.uri === request.uri &&
    state.requestVersion === request.requestVersion
  );
}

export function reduceMarkdownImageLoadState(
  state: MarkdownImageLoadState,
  event: MarkdownImageLoadEvent,
): MarkdownImageLoadState {
  switch (event.type) {
    case "source-changed":
      return createMarkdownImageLoadState(event);
    case "failed":
      if (!isCurrentMarkdownImageRequest(state, event.request)) {
        return state;
      }
      return {
        ...state,
        failed: true,
      };
    case "loaded":
      return isCurrentMarkdownImageRequest(state, event.request)
        ? { ...state, failed: false, automaticRetryCount: 0 }
        : state;
    case "retry":
      return state.uri === null
        ? state
        : {
            ...state,
            failed: false,
            automaticRetryCount: event.automatic
              ? Math.min(MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES, state.automaticRetryCount + 1)
              : 0,
            requestVersion: state.requestVersion + 1,
          };
  }
}

export function shouldAutomaticallyRetryMarkdownImage(
  state: MarkdownImageLoadState,
  input: { readonly uri: string | null; readonly unavailable: boolean },
): boolean {
  return (
    !input.unavailable &&
    input.uri !== null &&
    state.uri === input.uri &&
    state.failed &&
    state.automaticRetryCount < MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES
  );
}
