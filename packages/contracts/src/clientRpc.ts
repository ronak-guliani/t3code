import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentRpcAuthorization } from "./auth.ts";
import {
  CapabilityClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import {
  WsRpcGroup,
  WsProviderConsumeResetCreditRpc,
  WsProviderUploadFeedbackRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSubscribeResourceTelemetryRpc,
} from "./rpc.ts";

// Client-side schema superset; optional members never become fork server handlers.
export const WsClientRpcGroup = WsRpcGroup.omit(ORCHESTRATION_WS_METHODS.dispatchCommand)
  .add(
    Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      payload: CapabilityClientOrchestrationCommand,
      success: OrchestrationRpcSchemas.dispatchCommand.output,
      error: OrchestrationDispatchCommandError,
    }),
    WsProviderConsumeResetCreditRpc,
    WsProviderUploadFeedbackRpc,
    WsServerGetUsageSummaryRpc,
    WsServerRefreshUsageRatesRpc,
    WsAttachmentsCreateUploadUrlRpc,
    WsAttachmentsDeleteRpc,
    WsPullRequestsSummaryRpc,
    WsPullRequestsThreadCommentsRpc,
    WsPullRequestsDiffFileContentsRpc,
    WsPullRequestsUpdateRpc,
    WsPullRequestsUpdateCommentRpc,
    WsPullRequestsSetReactionRpc,
    WsPullRequestsSubscribeRefreshesRpc,
    WsPullRequestsLabelCandidatesRpc,
    WsPullRequestsSetLabelsRpc,
    WsSubscribeResourceTelemetryRpc,
  )
  .middleware(EnvironmentRpcAuthorization);
