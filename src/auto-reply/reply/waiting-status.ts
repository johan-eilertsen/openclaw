import type { AcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { adoptMediaGenerationProgressDraft } from "../../agents/media-generation-activity.js";
import type { ReplyCompletion } from "../../agents/reply-completion.js";
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { ProgressContinuationCapability } from "../../channels/progress-continuation.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  if (
    params.completion.expectation !== "required" ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    {
      text:
        params.yieldAcknowledgment?.trim() ||
        "I’m continuing this work and will send the result when it is ready.",
    },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}

/**
 * Ordinary and queued waiting replies offer their progress draft to the work
 * that owes the result: the yielding turn's children, or its in-flight media runs.
 */
export async function attachWaitingStatusProgressContinuation(params: {
  payload?: ReplyPayload;
  replyPayloads?: readonly ReplyPayload[];
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  followups?: readonly FollowupCompletionOwner[];
  /** Set only for a media continuation, which has no completion child. */
  mediaRequester?: { sessionKey: string; agentId?: string };
  operation: ReplyOperation;
}): Promise<void> {
  const { acceptedSessionSpawns, followups, mediaRequester, operation } = params;
  const payload =
    params.payload ??
    (followups?.length ? params.replyPayloads?.findLast((reply) => !reply.isError) : undefined);
  if (!payload) {
    return;
  }
  let adoptDraft: ProgressContinuationCapability["adopt"];
  if (mediaRequester) {
    adoptDraft = (draft) =>
      adoptMediaGenerationProgressDraft(mediaRequester.sessionKey, mediaRequester.agentId, draft);
  } else if (acceptedSessionSpawns?.length || followups?.length) {
    // Ordinary replies must not load the subagent registry.
    const { adoptSubagentProgressDraft } =
      await import("../../agents/subagents/registry/subagent-progress-draft.js");
    adoptDraft = (draft) =>
      adoptSubagentProgressDraft(acceptedSessionSpawns ?? [], draft, followups);
  } else {
    return;
  }
  let open = true;
  setReplyPayloadMetadata(payload, {
    progressContinuation: {
      ...(payload !== params.payload ? { preserveReply: true } : {}),
      adopt: (draft) =>
        open && resolveReplyOperationAbortReason(operation) === undefined && adoptDraft(draft),
      close: () => {
        open = false;
      },
    },
  });
}
