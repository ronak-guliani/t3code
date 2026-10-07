import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  EnvironmentId,
  FileReference,
  PreviewNavigateInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { toWorkspaceRelativePath } from "~/filePathDisplay";
import {
  openPreviewSession,
  type OpenPreviewMutation,
} from "~/components/preview/openPreviewSession";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export type FileReferenceAssetCreator = (
  input: AssetCreateUrlInput,
) => Promise<AssetCreateUrlResult>;

export type NavigatePreviewMutation<E> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewNavigateInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

type AttachmentReference = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly previewUrl?: string;
};

type OpenPathReferenceInput<E> = {
  readonly kind?: "path";
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly cwd: string | undefined;
  readonly line?: number;
  readonly column?: number;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: FileReferenceAssetCreator;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly navigatePreview: NavigatePreviewMutation<E>;
};

export type OpenAttachmentReferenceInput = {
  readonly kind: "attachments";
  readonly threadRef: ScopedThreadRef;
  readonly attachments: ReadonlyArray<AttachmentReference>;
  readonly selectedAttachmentId: string;
  readonly httpBaseUrl?: string;
  readonly createAssetUrl?: FileReferenceAssetCreator;
  readonly onOpenGallery: (
    attachments: ReadonlyArray<AttachmentReference & { readonly previewUrl: string }>,
    selectedAttachmentId: string,
  ) => void;
};

export type OpenFileReferenceInput<E> = OpenPathReferenceInput<E> | OpenAttachmentReferenceInput;

interface CachedReference {
  readonly expiresAt: number;
  readonly viewMode: NonNullable<AssetCreateUrlResult["fileReference"]>["viewMode"];
  readonly relativeUrl: string;
  readonly tabId?: string;
  readonly metadata: NonNullable<AssetCreateUrlResult["fileReference"]>;
}

const referenceCache = new Map<string, CachedReference>();
const pendingReferenceOpens = new Map<string, Promise<AtomCommandResult<void, unknown>>>();
const URL_REFRESH_SKEW_MS = 15_000;

function referenceKey(
  input: Pick<OpenPathReferenceInput<unknown>, "threadRef" | "filePath">,
): string {
  return `${scopedThreadKey(input.threadRef)}\0${input.filePath}`;
}

function isCacheLive(cache: CachedReference | undefined): cache is CachedReference {
  return cache !== undefined && cache.expiresAt > Date.now() + URL_REFRESH_SKEW_MS;
}

async function openAttachments(input: OpenAttachmentReferenceInput): Promise<void> {
  const selected = input.attachments.find(
    (attachment) => attachment.id === input.selectedAttachmentId,
  );
  if (!selected) throw new Error("The attachment is no longer available.");
  if (selected.previewUrl) {
    input.onOpenGallery(
      input.attachments.filter(
        (attachment): attachment is AttachmentReference & { readonly previewUrl: string } =>
          Boolean(attachment.previewUrl),
      ),
      input.selectedAttachmentId,
    );
    return;
  }
  const { httpBaseUrl, createAssetUrl } = input;
  if (!httpBaseUrl || !createAssetUrl) {
    throw new Error("The owning environment is unavailable.");
  }
  const resolved = await Promise.all(
    input.attachments.map(async (attachment) => {
      if (attachment.previewUrl)
        return attachment as AttachmentReference & { readonly previewUrl: string };
      try {
        const reference: FileReference = {
          _tag: "attachment",
          environmentId: input.threadRef.environmentId,
          threadId: input.threadRef.threadId,
          attachmentId: attachment.id,
        };
        const asset = await createAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId: reference.attachmentId,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            disposition: "inline",
          },
        });
        return {
          ...attachment,
          previewUrl: new URL(asset.relativeUrl, httpBaseUrl).toString(),
        };
      } catch (error) {
        if (attachment.id === input.selectedAttachmentId) throw error;
        return null;
      }
    }),
  );
  const gallery = resolved.filter(
    (attachment): attachment is AttachmentReference & { readonly previewUrl: string } =>
      attachment !== null,
  );
  if (!gallery.some((attachment) => attachment.id === input.selectedAttachmentId)) {
    throw new Error("The attachment is no longer available.");
  }
  input.onOpenGallery(gallery, input.selectedAttachmentId);
}

async function openPathReference<E>(
  input: OpenPathReferenceInput<E>,
): Promise<AtomCommandResult<void, E>> {
  const workspacePath = toWorkspaceRelativePath(input.filePath, input.cwd);
  if (workspacePath && !isBrowserPreviewFile(input.filePath)) {
    useRightPanelStore
      .getState()
      .openFile(input.threadRef, workspacePath, input.line, input.column);
    return AsyncResult.success(undefined);
  }

  const key = referenceKey(input);
  const now = Date.now();
  for (const [cachedKey, cachedReference] of referenceCache) {
    if (cachedKey !== key && cachedReference.expiresAt <= now) referenceCache.delete(cachedKey);
  }
  const existingPending = pendingReferenceOpens.get(key);
  if (existingPending) return (await existingPending) as AtomCommandResult<void, E>;

  const open = async (): Promise<AtomCommandResult<void, E>> => {
    let cached = referenceCache.get(key);
    const liveCachedTab = cached?.tabId
      ? readThreadPreviewState(input.threadRef).sessions[cached.tabId]
      : undefined;
    if (isCacheLive(cached) && cached.tabId && liveCachedTab) {
      useRightPanelStore.getState().openBrowser(input.threadRef, cached.tabId);
      return AsyncResult.success(undefined);
    }
    const reusableTabId = liveCachedTab?.tabId;
    if (cached?.tabId && !liveCachedTab) {
      referenceCache.delete(key);
      cached = undefined;
    } else if (!isCacheLive(cached)) {
      cached = undefined;
    }
    let asset: AssetCreateUrlResult | null = null;
    if (!cached) {
      const reference: FileReference = {
        _tag: "path",
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        path: input.filePath,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.column === undefined ? {} : { column: input.column }),
      };
      asset = await input.createAssetUrl({
        resource: {
          _tag: "referenced-file",
          threadId: reference.threadId,
          path: reference.path,
          ...(reference.line === undefined ? {} : { line: reference.line }),
          ...(reference.column === undefined ? {} : { column: reference.column }),
        },
      });
    }
    if (asset) {
      const metadata = asset.fileReference;
      if (!metadata) throw new Error("The environment did not resolve this file reference.");
      cached = {
        expiresAt: asset.expiresAt,
        viewMode: metadata.viewMode,
        relativeUrl: asset.relativeUrl,
        metadata,
        ...(reusableTabId ? { tabId: reusableTabId } : {}),
      };
      referenceCache.set(key, cached);
    }
    if (!cached) throw new Error("Unable to resolve this file reference.");

    if (cached.viewMode === "text") {
      const relativePath = toWorkspaceRelativePath(input.filePath, input.cwd);
      if (relativePath) {
        useRightPanelStore
          .getState()
          .openFile(input.threadRef, relativePath, input.line, input.column);
      } else {
        useRightPanelStore.getState().openExternalFile(input.threadRef, {
          kind: "external",
          path: input.filePath,
          ...(input.line === undefined ? {} : { line: input.line }),
          ...(input.column === undefined ? {} : { column: input.column }),
          metadata: cached.metadata,
          assetExpiresAt: cached.expiresAt,
        });
      }
      return AsyncResult.success(undefined);
    }

    const canOpenIntegratedBrowser = cached.viewMode === "html" || cached.viewMode === "document";
    if (!canOpenIntegratedBrowser || !isPreviewSupportedInRuntime()) {
      useRightPanelStore.getState().openExternalFile(input.threadRef, {
        kind: toWorkspaceRelativePath(input.filePath, input.cwd) ? "workspace" : "external",
        path: input.filePath,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.column === undefined ? {} : { column: input.column }),
        metadata: cached.metadata,
        assetExpiresAt: cached.expiresAt,
      });
      return AsyncResult.success(undefined);
    }
    const url = new URL(cached.relativeUrl, input.httpBaseUrl).toString();
    if (cached.tabId) {
      const result = await input.navigatePreview({
        environmentId: input.threadRef.environmentId,
        input: {
          threadId: input.threadRef.threadId,
          tabId: cached.tabId as PreviewNavigateInput["tabId"],
          url,
        },
      });
      if (result._tag === "Success") {
        applyPreviewServerSnapshot(input.threadRef, result.value);
        rememberPreviewUrl(
          input.threadRef,
          result.value.navStatus._tag === "Idle" ? url : result.value.navStatus.url,
        );
        referenceCache.set(key, { ...cached, expiresAt: cached.expiresAt });
        useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
        return AsyncResult.success(undefined);
      }
      referenceCache.delete(key);
      return open();
    }

    const result = await openPreviewSession({
      openPreview: input.openPreview,
      threadRef: input.threadRef,
      url,
    });
    if (result._tag === "Success") {
      referenceCache.set(key, { ...cached, tabId: result.value.tabId });
    }
    return mapAtomCommandResult(result, (snapshot) => {
      useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
    });
  };

  const pending = open();
  pendingReferenceOpens.set(key, pending as Promise<AtomCommandResult<void, unknown>>);
  try {
    return await pending;
  } finally {
    if (pendingReferenceOpens.get(key) === pending) pendingReferenceOpens.delete(key);
  }
}

export function openFileReference<E>(
  input: OpenPathReferenceInput<E>,
): Promise<AtomCommandResult<void, E>>;
export function openFileReference(input: OpenAttachmentReferenceInput): Promise<void>;
export function openFileReference<E>(input: OpenFileReferenceInput<E>): Promise<unknown> {
  if (input.kind === "attachments") return openAttachments(input);
  return openPathReference(input);
}
