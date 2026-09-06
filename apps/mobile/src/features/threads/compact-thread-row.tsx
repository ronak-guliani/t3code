import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { memo, type ComponentProps } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useAppNavigation } from "../../lib/use-app-navigation";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type {
  MobileThreadShell,
  MobileThreadTreeRow,
  NestedThreadStatus,
} from "./mobile-thread-hierarchy";
import { useUnreadChildNotification } from "./thread-hierarchy-controls";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

export type CompactThreadStatus = NestedThreadStatus | "queued" | "plan-ready";

const STATUS: Record<CompactThreadStatus, { label: string; color: string; action?: string }> = {
  ready: { label: "", color: "bg-transparent" },
  working: { label: "Working", color: "bg-adaptive-sky-600-400" },
  approval: { label: "Needs approval", color: "bg-adaptive-amber-700-300", action: "Approval" },
  input: { label: "Awaiting input", color: "bg-adaptive-indigo-600-300", action: "Input" },
  failed: { label: "Failed", color: "bg-adaptive-red-700-300", action: "Failed" },
  queued: { label: "Queued", color: "bg-foreground-tertiary" },
  "plan-ready": { label: "Plan ready", color: "bg-adaptive-violet-700-300", action: "Plan" },
};

function RelatedThreadsButton(props: {
  readonly thread: MobileThreadShell;
  readonly hierarchy?: MobileThreadTreeRow | undefined;
  readonly selected: boolean;
}) {
  const navigation = useAppNavigation();
  const unread = useUnreadChildNotification(
    props.thread,
    props.hierarchy?.latestRelatedNotificationAt,
  );
  const count = props.hierarchy?.childCount ?? 0;
  if (count === 0 && !unread) return null;
  const groupStatus = props.hierarchy?.displayStatus ?? "ready";
  const status = STATUS[groupStatus];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Related chats for ${props.thread.title}, ${count}${unread ? ", unread activity" : ""}${status.label ? `, ${status.label.toLowerCase()} in group` : ""}`}
      accessibilityHint="Opens the related chat group"
      onPress={() =>
        navigation.navigate("RelatedThreads", {
          environmentId: props.thread.environmentId,
          threadId: props.thread.id,
        })
      }
      style={styles.relatedButton}
    >
      <View
        className={cn(
          "flex-row items-center gap-1 rounded-md px-1.5 py-1",
          props.selected ? "bg-user-bubble-foreground/15" : "bg-subtle",
        )}
      >
        <SymbolView
          name="bubble.left.and.bubble.right"
          size={12}
          tintColorClassName={
            props.selected ? "accent-user-bubble-foreground" : "accent-foreground-muted"
          }
        />
        {count > 0 ? (
          <Text
            className={cn(
              "text-xs tabular-nums font-t3-medium",
              props.selected ? "text-user-bubble-foreground" : "text-foreground-muted",
            )}
          >
            {count}
          </Text>
        ) : null}
        {unread || groupStatus !== "ready" ? (
          <View
            className={cn(
              "absolute -right-0.5 -top-0.5 size-1.5 rounded-full",
              groupStatus !== "ready" ? status.color : "bg-adaptive-blue-600-400",
            )}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** Primary and related-chat actions are siblings, so assistive navigation reaches both. */
export const CompactThreadRow = memo(function CompactThreadRow(props: {
  readonly title: string;
  readonly timestamp: string;
  readonly status: CompactThreadStatus;
  readonly onPress: () => void;
  readonly menu?: Pick<ComponentProps<typeof ControlPillMenu>, "actions" | "onPressAction">;
  readonly accessibilityHint?: string;
  readonly selected?: boolean;
  readonly muted?: boolean;
  readonly pinned?: boolean;
  readonly sidebar?: boolean;
  readonly showDivider?: boolean;
  readonly related?: {
    readonly thread: MobileThreadShell;
    readonly hierarchy?: MobileThreadTreeRow | undefined;
  };
  readonly searchMatch?: EnvironmentThreadSearchMatch | undefined;
  readonly searchQuery?: string | undefined;
}) {
  const theme = useUniwindTheme();
  const selected = props.selected === true;
  const status = STATUS[props.status];
  const foreground = selected
    ? "text-user-bubble-foreground"
    : props.muted
      ? "text-foreground-muted"
      : "text-foreground";
  const accessibilityLabel = `${props.title}${status.label ? `, ${status.label}` : ""}${props.pinned ? ", pinned" : ""}, ${props.timestamp}`;
  const primary = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={props.accessibilityHint ?? "Opens the thread"}
      accessibilityState={{ selected }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.primaryButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View className="w-3 items-center">
        {props.pinned && props.status === "ready" ? (
          <SymbolView
            name="pin.fill"
            size={10}
            tintColorClassName={
              selected ? "accent-user-bubble-foreground" : "accent-foreground-tertiary"
            }
          />
        ) : (
          <View
            className={cn(
              "size-1.5 rounded-full",
              selected && props.status !== "ready" ? "bg-user-bubble-foreground" : status.color,
            )}
          />
        )}
      </View>
      <Text className={cn("flex-1 text-base font-t3-medium", foreground)} numberOfLines={1}>
        {props.title}
      </Text>
      {status.action ? (
        <Text
          className={cn(
            "text-xs",
            selected ? "text-user-bubble-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {status.action}
        </Text>
      ) : null}
    </Pressable>
  );
  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: selected
            ? theme["--color-user-bubble"]
            : props.sidebar
              ? theme["--color-drawer"]
              : theme["--color-screen"],
          paddingHorizontal: props.sidebar ? 12 : 18,
        },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.primarySlot}>
          {props.menu ? (
            <ControlPillMenu
              {...props.menu}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityHint={props.accessibilityHint ?? "Opens the thread"}
              accessibilityState={{ selected }}
              onAccessibilityTap={props.onPress}
              shouldOpenOnLongPress
            >
              {primary}
            </ControlPillMenu>
          ) : (
            primary
          )}
        </View>
        {props.related ? <RelatedThreadsButton {...props.related} selected={selected} /> : null}
        <Text
          accessible={false}
          className={cn(
            "text-xs tabular-nums",
            selected ? "text-user-bubble-foreground-muted" : "text-foreground-tertiary",
          )}
          numberOfLines={1}
          style={styles.timestamp}
        >
          {props.timestamp}
        </Text>
      </View>
      {props.searchMatch ? (
        <View style={styles.excerpt}>
          <ThreadSearchMatchExcerpt
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
      {props.showDivider ? <View className="bg-border-subtle" style={styles.divider} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { borderRadius: 10 },
  primarySlot: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 48, gap: 4 },
  primaryButton: {
    minWidth: 0,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  relatedButton: { minWidth: 44, minHeight: 48, alignItems: "center", justifyContent: "center" },
  timestamp: { minWidth: 30, textAlign: "right" },
  excerpt: { paddingLeft: 20, paddingBottom: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 20 },
});
