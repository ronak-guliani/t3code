import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useId, useReducer, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";
import { PresentationSource } from "../../components/NativePresentation";
import { useMediaActions, type MediaActionsSource } from "../../lib/mediaActions";
import { useAssetUrlState } from "../../state/assets";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "./markdownImageSize";
import {
  createMarkdownImageLoadState,
  reduceMarkdownImageLoadState,
  shouldAutomaticallyRetryMarkdownImage,
} from "./markdownImageLoadState";

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [imageLoadState, dispatchImageLoad] = useReducer(
    reduceMarkdownImageLoadState,
    { sourceKey: props.sourceKey, uri: props.uri },
    createMarkdownImageLoadState,
  );

  useEffect(() => {
    setSourceSize(null);
    dispatchImageLoad({
      type: "source-changed",
      sourceKey: props.sourceKey,
      uri: props.uri,
    });
  }, [props.sourceKey, props.uri]);

  useEffect(() => {
    if (
      !shouldAutomaticallyRetryMarkdownImage(imageLoadState, {
        uri: props.uri,
        unavailable: props.unavailable,
      })
    ) {
      return;
    }
    const retryTimer = setTimeout(() => {
      dispatchImageLoad({ type: "retry", automatic: true });
    }, 500);
    return () => clearTimeout(retryTimer);
  }, [imageLoadState, props.unavailable, props.uri]);

  const retryImage = useCallback(() => {
    if (props.uri === null || props.unavailable) {
      return;
    }
    dispatchImageLoad({ type: "retry", automatic: false });
  }, [props.unavailable, props.uri]);

  const displaySize =
    sourceSize === null
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed =
    props.unavailable ||
    (props.uri !== null && imageLoadState.uri === props.uri && imageLoadState.failed);
  const canRetry = failed && props.uri !== null && !props.unavailable;
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <MediaActionsMenu media={mediaActions}>
          <Pressable
            accessibilityRole={canRetry ? "button" : "image"}
            accessibilityLabel={
              canRetry
                ? `${props.alt ?? "Image"} unavailable. Retry`
                : (props.alt ?? "Markdown image")
            }
            accessibilityHint={
              canRetry
                ? "Double tap to retry loading this image"
                : mediaActions.actions.length > 0
                  ? "Touch and hold for media actions"
                  : undefined
            }
            onPress={canRetry ? retryImage : undefined}
            className="items-center justify-center rounded-[10px] bg-md-code-bg"
            style={frameStyle}
          >
            {failed ? (
              <Text className="text-xs text-foreground-muted">Image unavailable</Text>
            ) : (
              <ActivityIndicator />
            )}
          </Pressable>
        </MediaActionsMenu>
      ) : (
        <PresentationSource identifier={sourceIdentifier} style={{ alignSelf: "flex-start" }}>
          <MediaActionsMenu media={mediaActions}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={props.alt ?? "Markdown image"}
              accessibilityHint={
                mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
              }
              onPress={() =>
                props.onPressPreview({
                  kind: "image",
                  uri: props.uri!,
                  name: props.actionsSource?.name ?? props.alt ?? "Image",
                  sourceIdentifier,
                  actionsSource: props.actionsSource,
                })
              }
              style={{ alignSelf: "flex-start" }}
            >
              <View
                className="items-center justify-center overflow-hidden rounded-[10px] bg-md-code-bg"
                style={{
                  ...frameStyle,
                }}
              >
                <ThreadMarkdownImageRequest
                  uri={props.uri!}
                  key={`${props.uri}:${imageLoadState.requestVersion}`}
                  onLoad={(sourceSize) => {
                    dispatchImageLoad({ type: "loaded", uri: props.uri! });
                    setSourceSize(sourceSize);
                  }}
                  onError={() => dispatchImageLoad({ type: "failed", uri: props.uri! })}
                />
              </View>
            </Pressable>
          </MediaActionsMenu>
        </PresentationSource>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) => {
          setLoaded(true);
          props.onLoad(event.nativeEvent.source);
        }}
        onError={props.onError}
        style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
      />
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">Loading image…</Text>
        </View>
      )}
    </>
  );
}

/** Environment-hosted image that loads through a signed asset URL. */
export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "media-file" }>;
  readonly alt: string | null;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null}
      sourceKey={
        props.resource._tag === "attachment"
          ? `attachment:${props.resource.attachmentId}`
          : `workspace:${props.resource.path}`
      }
      unavailable={assetUrl._tag === "Failure"}
      alt={props.alt}
      actionsSource={props.actionsSource}
      onPressPreview={props.onPressPreview}
    />
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressPreview={() => undefined}
    />
  );
}
