import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hostedApi, hostedMeKey, type HostedAttempt } from "../api/hosted";
import { useHosted } from "./useHosted";

export const sessionBillingKey = (sessionId: string) =>
  ["hosted", "billing", "session", sessionId] as const;

function hasPendingAttempts(attempts: HostedAttempt[] | undefined): boolean {
  return (
    attempts?.some(
      (attempt) => attempt.status === "reserved" || attempt.status === "sent",
    ) ?? false
  );
}

/** One bounded watcher for the current turn; missing historical usage is final. */
export function useSessionBilling(
  sessionId: string,
  currentClientMessageId: string | undefined,
) {
  const hosted = useHosted();
  const client = useQueryClient();
  const watchStartedAt = useRef(Date.now());
  const previouslyPending = useRef(false);
  useEffect(() => {
    watchStartedAt.current = Date.now();
    previouslyPending.current = false;
  }, [sessionId, currentClientMessageId]);
  const billing = useQuery({
    queryKey: sessionBillingKey(sessionId),
    queryFn: () => hostedApi.sessionBilling(sessionId),
    enabled: Boolean(hosted),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      currentClientMessageId &&
      Date.now() - watchStartedAt.current < 30_000 &&
      hasPendingAttempts(query.state.data?.turns[currentClientMessageId])
        ? 2500
        : false,
  });
  const pending = hasPendingAttempts(
    currentClientMessageId
      ? billing.data?.turns[currentClientMessageId]
      : undefined,
  );
  useEffect(() => {
    if (previouslyPending.current && !pending && billing.isSuccess)
      void client.invalidateQueries({ queryKey: hostedMeKey });
    previouslyPending.current = pending;
  }, [pending, billing.isSuccess, client]);
  return hosted ? billing : undefined;
}
