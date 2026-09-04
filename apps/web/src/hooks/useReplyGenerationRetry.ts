import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CorrespondenceReplyState } from "@personasim/contracts";
import { api } from "../api/client";
import { correspondenceQueryKeys } from "../lib/correspondence";
import {
  acquireReplyGenerationRetryLease,
  releaseReplyGenerationRetryLease,
  replyGenerationRetryLeaseAfterError,
  replyGenerationRetryErrorMessage,
  runReplyGenerationRetryAttempt,
  type ReplyGenerationRetryLease,
} from "../lib/correspondenceMutations";

interface ReplyGenerationRetryVariables {
  readonly agentId: string;
  readonly incomingLetterId: string;
}

export interface ReplyGenerationRetryControls {
  readonly isPending: boolean;
  readonly safeErrorMessage: string | undefined;
  readonly retry: () => void;
}

export function useReplyGenerationRetry(
  agentId: string,
  state: CorrespondenceReplyState | undefined,
): ReplyGenerationRetryControls {
  const queryClient = useQueryClient();
  const leaseRef = useRef<ReplyGenerationRetryLease | undefined>(undefined);
  const actionableIncomingLetterId =
    state?.kind === "failed" && state.canRetry
      ? state.incomingLetterId
      : undefined;
  const mutation = useMutation({
    mutationFn: async (variables: ReplyGenerationRetryVariables) => {
      const lease = acquireReplyGenerationRetryLease(
        leaseRef.current,
        variables.agentId,
        variables.incomingLetterId,
      );
      return runReplyGenerationRetryAttempt({
        initialLease: lease,
        confirmFollowUp: () =>
          confirmReplyGenerationStillRetryable(
            variables.agentId,
            variables.incomingLetterId,
          ),
        createFollowUpLease: () =>
          leaseRef.current === undefined
            ? acquireReplyGenerationRetryLease(
                undefined,
                variables.agentId,
                variables.incomingLetterId,
              )
            : undefined,
        submit: submitReplyGenerationRetry,
        onAttempt: (attempted) => {
          leaseRef.current = attempted;
        },
        onAcknowledged: (acknowledged) => {
          leaseRef.current = releaseReplyGenerationRetryLease(
            leaseRef.current,
            acknowledged,
          );
        },
        onRejected: (attempted, error) => {
          leaseRef.current = replyGenerationRetryLeaseAfterError(
            leaseRef.current,
            attempted,
            error,
          );
        },
      });
    },
    onSuccess: async (_response, variables) => {
      await invalidateReplyGenerationQueries(queryClient, variables.agentId);
    },
    onError: async (_error, variables) => {
      await invalidateReplyGenerationQueries(queryClient, variables.agentId);
    },
  });
  const resetMutation = mutation.reset;

  useEffect(() => {
    if (mutation.isPending) return;
    const current = leaseRef.current;
    const identityChanged =
      current !== undefined &&
      (current.agentId !== agentId ||
        current.incomingLetterId !== actionableIncomingLetterId);
    const hasSettledMutation = mutation.isError || mutation.isSuccess;
    if (
      (actionableIncomingLetterId === undefined || identityChanged) &&
      (current !== undefined || hasSettledMutation)
    ) {
      leaseRef.current = undefined;
      resetMutation();
    }
  }, [
    actionableIncomingLetterId,
    agentId,
    mutation.isError,
    mutation.isPending,
    mutation.isSuccess,
    resetMutation,
  ]);

  const errorMatchesCurrentState =
    mutation.isError &&
    mutation.variables?.agentId === agentId &&
    mutation.variables.incomingLetterId === actionableIncomingLetterId;

  return {
    isPending: mutation.isPending,
    safeErrorMessage: errorMatchesCurrentState
      ? replyGenerationRetryErrorMessage(mutation.error)
      : undefined,
    retry: () => {
      if (
        !agentId ||
        actionableIncomingLetterId === undefined ||
        mutation.isPending
      ) {
        return;
      }
      mutation.mutate({
        agentId,
        incomingLetterId: actionableIncomingLetterId,
      });
    },
  };
}

async function submitReplyGenerationRetry(lease: ReplyGenerationRetryLease) {
  const response = await api.letters.retryReplyGeneration(
    lease.incomingLetterId,
    { clientRequestId: lease.clientRequestId },
  );
  if (response.incomingLetterId !== lease.incomingLetterId) {
    throw new Error("Reply recovery response did not match its request");
  }
  return response;
}

async function confirmReplyGenerationStillRetryable(
  agentId: string,
  incomingLetterId: string,
): Promise<boolean> {
  const mailbox = await api.correspondence.list(agentId);
  return mailbox.threads.some(
    (thread) =>
      thread.status === "open" &&
      thread.replyState?.kind === "failed" &&
      thread.replyState.canRetry &&
      thread.replyState.incomingLetterId === incomingLetterId,
  );
}

async function invalidateReplyGenerationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: correspondenceQueryKeys.mailbox(agentId),
    }),
    queryClient.invalidateQueries({
      queryKey: correspondenceQueryKeys.temporalTasks(agentId),
    }),
    queryClient.invalidateQueries({
      queryKey: ["agent", agentId, "timeline"],
    }),
  ]);
}
