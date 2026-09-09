import { useNavigation, type StaticScreenProps, StackActions } from "@react-navigation/native";
import type { GitResolvedPullRequest } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { cn } from "../../lib/cn";
import {
  buildPullRequestReviewWorkflowInput,
  reviewThreadRef,
  reviewWorkflowDisabledReason,
} from "./pullRequestReviewWorkflow";

const CHILD_THREAD_WAIT_MS = 8_000;

type PullRequestReviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function errorMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function waitForChildThread(
  ref: ReturnType<typeof reviewThreadRef>,
  timeoutMs = CHILD_THREAD_WAIT_MS,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(atom) !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    const finish = (visible: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      unsubscribe();
      resolve(visible);
    };
    const subscription = appAtomRegistry.subscribe(atom, (thread) => {
      if (thread !== null) finish(true);
    });
    unsubscribe = subscription;
    if (settled) {
      unsubscribe();
      return;
    }
    timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

export function PullRequestReviewSheet(_props: PullRequestReviewSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitStatus = useEnvironmentQuery(
    selectedThread && selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const prewarmChangesContext = useAtomCommand(reviewEnvironment.prewarmChangesContext, {
    reportFailure: false,
  });
  const runWorkflow = useAtomCommand(reviewEnvironment.runWorkflow, {
    reportFailure: false,
  });
  const [startingPullRequestNumber, setStartingPullRequestNumber] = useState<number | null>(null);
  const launchPending = useRef(false);
  const retryLaunch = useRef<{
    readonly pullRequestNumber: number;
    readonly idempotencyKey: string;
  } | null>(null);

  const settings = selectedEnvironmentRuntime?.serverConfig?.settings;
  const reviewSettings = settings?.agentWorkflows.reviewChanges;
  const modelSelection =
    reviewSettings?.modelSelection ??
    selectedThreadProject?.defaultModelSelection ??
    selectedThread?.modelSelection ??
    null;
  const connected = selectedEnvironmentRuntime?.connectionState === "connected";
  const isRepo = gitStatus.data?.isRepo ?? true;
  const disabledReason = reviewWorkflowDisabledReason({
    supported:
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.agentWorkflows === true,
    connected,
    enabled: reviewSettings?.enabled ?? false,
    isRepo,
    cwd: selectedThreadCwd,
    modelSelection,
  });
  const pullRequests = useEnvironmentQuery(
    selectedThread && selectedThreadCwd && disabledReason === null
      ? reviewEnvironment.openPullRequests({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const prewarmPullRequest = useCallback(
    (pullRequestNumber: number) => {
      if (!selectedThread || !selectedThreadCwd || disabledReason !== null) return;
      void prewarmChangesContext({
        environmentId: selectedThread.environmentId,
        input: {
          cwd: selectedThreadCwd,
          scope: "pull-request",
          pullRequestNumber,
        },
      });
    },
    [disabledReason, prewarmChangesContext, selectedThread, selectedThreadCwd],
  );

  const startReview = useCallback(
    async (pullRequestNumber: number) => {
      if (
        launchPending.current ||
        disabledReason !== null ||
        !selectedThread ||
        !selectedThreadProject ||
        !selectedThreadCwd ||
        !modelSelection
      ) {
        return;
      }

      const idempotencyKey =
        retryLaunch.current?.pullRequestNumber === pullRequestNumber
          ? retryLaunch.current.idempotencyKey
          : uuidv4();
      retryLaunch.current = { pullRequestNumber, idempotencyKey };
      launchPending.current = true;
      setStartingPullRequestNumber(pullRequestNumber);
      const result = await runWorkflow({
        environmentId: selectedThread.environmentId,
        input: buildPullRequestReviewWorkflowInput({
          threadId: selectedThread.id,
          projectId: selectedThreadProject.id,
          cwd: selectedThreadCwd,
          pullRequestNumber,
          idempotencyKey,
          modelSelection,
          runtimeMode: selectedThread.runtimeMode,
          interactionMode: selectedThread.interactionMode,
        }),
      });

      if (result._tag === "Failure") {
        launchPending.current = false;
        setStartingPullRequestNumber(null);
        Alert.alert(
          "Could not start review",
          errorMessage(result.cause, "Try again when the environment is connected."),
        );
        return;
      }

      launchPending.current = false;
      retryLaunch.current = null;
      if (result.value.status === "skipped") {
        setStartingPullRequestNumber(null);
        Alert.alert("Review not started", result.value.message);
        return;
      }

      const childRef = reviewThreadRef(selectedThread.environmentId, result.value.threadId);
      if (!(await waitForChildThread(childRef))) {
        setStartingPullRequestNumber(null);
        Alert.alert(
          "Review started",
          "The review chat could not be opened yet. Find it under this thread's related chats.",
        );
        return;
      }

      navigation.dispatch(
        StackActions.popTo("Thread", {
          environmentId: String(childRef.environmentId),
          threadId: String(childRef.threadId),
        }),
      );
    },
    [
      disabledReason,
      modelSelection,
      navigation,
      runWorkflow,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject,
    ],
  );

  const rows = pullRequests.data?.pullRequests ?? [];
  const emptyMessage = useMemo(() => {
    if (disabledReason) return disabledReason;
    if (pullRequests.error) return pullRequests.error;
    if (pullRequests.isPending) return null;
    return "No open pull requests were found for this repository.";
  }, [disabledReason, pullRequests.error, pullRequests.isPending]);

  const renderPullRequest = useCallback(
    ({ item }: { readonly item: GitResolvedPullRequest }) => {
      const starting = startingPullRequestNumber === item.number;
      const disabled = startingPullRequestNumber !== null;
      return (
        <Pressable
          accessibilityLabel={`Review pull request ${item.number}: ${item.title}`}
          accessibilityRole="button"
          className={cn(
            "mx-5 mb-3 min-h-[76px] flex-row items-center gap-3 rounded-[20px] border border-border bg-card px-4 py-3",
            disabled && !starting && "opacity-45",
          )}
          disabled={disabled}
          onPressIn={() => prewarmPullRequest(item.number)}
          onPress={() => void startReview(item.number)}
        >
          <View className="h-10 w-10 items-center justify-center rounded-full bg-subtle">
            {starting ? (
              <ActivityIndicator />
            ) : (
              <SymbolView
                name="arrow.triangle.pull"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-sm font-t3-bold text-foreground" numberOfLines={2}>
              #{item.number} {item.title}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {item.headBranch} → {item.baseBranch}
            </Text>
          </View>
          {!starting ? (
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          ) : null}
        </Pressable>
      );
    },
    [prewarmPullRequest, startReview, startingPullRequestNumber],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Review pull request" onBack={() => navigation.goBack()} />
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(pullRequest) => String(pullRequest.number)}
        renderItem={renderPullRequest}
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18),
        }}
        refreshControl={
          disabledReason === null ? (
            <RefreshControl refreshing={pullRequests.isPending} onRefresh={pullRequests.refresh} />
          ) : undefined
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center gap-3 px-8 py-12">
            {pullRequests.isPending ? <ActivityIndicator /> : null}
            {emptyMessage ? (
              <>
                <SymbolView
                  name="arrow.triangle.pull"
                  size={28}
                  tintColorClassName="accent-icon-subtle"
                  type="monochrome"
                />
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  {emptyMessage}
                </Text>
              </>
            ) : null}
          </View>
        }
      />
    </View>
  );
}
