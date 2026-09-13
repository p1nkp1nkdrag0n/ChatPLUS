import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, PenLine } from "lucide-react";
import type { CharacterSummary } from "../../api/types";
import { ApiError } from "../../api/types";
import {
  diariesApi,
  diaryErrorMessage,
  diaryQueryKeys,
  diaryTimezone,
  localDiaryDate,
  type DiaryEntry,
  type GenerateDiaryInput,
} from "../../api/diaries";
import { createUuid } from "../../lib/uuid";

export function DiaryComposer({
  characters,
  initialAgentId,
  initialEntry,
  onGenerated,
}: {
  characters: readonly CharacterSummary[];
  initialAgentId: string;
  initialEntry?: DiaryEntry;
  onGenerated: (entry: DiaryEntry) => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(
    initialEntry?.agentId ?? initialAgentId,
  );
  const [entryDate, setEntryDate] = useState(
    initialEntry?.entryDate ?? localDiaryDate(),
  );
  const [success, setSuccess] = useState("");
  const uncertainAttempt = useRef<
    { signature: string; input: GenerateDiaryInput } | undefined
  >(undefined);
  const month = entryDate.slice(0, 7);
  const entries = useQuery({
    queryKey: diaryQueryKeys.entries(agentId, month),
    queryFn: () => diariesApi.entries(agentId, month),
    enabled: Boolean(agentId && /^\d{4}-\d{2}$/u.test(month)),
    staleTime: 0,
  });
  const existing = entries.data?.entries.find(
    (entry) => entry.entryDate === entryDate,
  );
  const mutation = useMutation({
    mutationFn: (input: GenerateDiaryInput) =>
      diariesApi.generate(agentId, input),
    onSuccess: ({ entry }) => {
      uncertainAttempt.current = undefined;
      queryClient.setQueryData<{ entries: DiaryEntry[] }>(
        diaryQueryKeys.entries(entry.agentId, entry.entryDate.slice(0, 7)),
        (old) => ({
          entries: [
            ...(old?.entries ?? []).filter((item) => item.id !== entry.id),
            entry,
          ].sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
        }),
      );
      void queryClient.invalidateQueries({
        queryKey: diaryQueryKeys.volumes(),
      });
      setSuccess(
        `${Number(entry.entryDate.slice(5, 7))} 月 ${Number(entry.entryDate.slice(8))} 日的手记已放上书架。`,
      );
      onGenerated(entry);
    },
    onError: (error) => {
      // Network uncertainty retries the same operation; an explicit server error starts a fresh attempt.
      if (error instanceof ApiError) uncertainAttempt.current = undefined;
      if (error instanceof ApiError && error.status === 409)
        void queryClient.invalidateQueries({
          queryKey: diaryQueryKeys.entries(agentId, month),
        });
    },
  });
  const reset = () => {
    setSuccess("");
    mutation.reset();
    uncertainAttempt.current = undefined;
  };
  const submit = () => {
    if (
      mutation.isPending ||
      entries.isPending ||
      entries.isFetching ||
      entries.isError ||
      !agentId ||
      !entryDate
    )
      return;
    const signature = `${agentId}:${entryDate}:${existing?.revision ?? 0}`;
    const input: GenerateDiaryInput =
      uncertainAttempt.current?.signature === signature
        ? uncertainAttempt.current.input
        : {
            entryDate,
            timezone: existing?.timezone ?? diaryTimezone(),
            clientRequestId: createUuid(),
            ...(existing ? { expectedRevision: existing.revision } : {}),
          };
    uncertainAttempt.current = { signature, input };
    setSuccess("");
    mutation.mutate(input);
  };
  return (
    <section className="ml-composer" aria-label="写进日记">
      <div className="ml-composer-heading">
        <PenLine size={19} aria-hidden="true" />
        <div>
          <h2>让这一天留在纸上</h2>
          <p>从当天的聊天里，由角色写下一篇自己的手记。</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label>
          谁的手记
          <select
            value={agentId}
            disabled={mutation.isPending}
            onChange={(event) => {
              setAgentId(event.target.value);
              reset();
            }}
            required
          >
            <option value="">选择角色</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          哪一天
          <input
            type="date"
            value={entryDate}
            max={localDiaryDate()}
            required
            disabled={mutation.isPending}
            onChange={(event) => {
              setEntryDate(event.target.value);
              reset();
            }}
          />
        </label>
        <button
          type="submit"
          className="ml-primary"
          disabled={
            !agentId ||
            !entryDate ||
            entries.isPending ||
            entries.isFetching ||
            entries.isError ||
            mutation.isPending
          }
        >
          {mutation.isPending ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <PenLine size={16} aria-hidden="true" />
          )}
          {mutation.isPending
            ? "正在写下这一天…"
            : existing
              ? "重新整理这篇手记"
              : "写进日记"}
        </button>
      </form>
      {existing && !success ? (
        <p className="ml-composer-note">
          这一天已经有手记。重新整理成功后，书中会显示更新后的内容。
        </p>
      ) : null}
      {mutation.isPending ? (
        <p className="ml-composer-note" role="status">
          正在重读这一天的聊天，写好后会自动收进对应月份。
        </p>
      ) : null}
      {entries.isError ? (
        <p className="ml-form-error" role="alert">
          还没能读取这一天的手记。
          <button type="button" onClick={() => void entries.refetch()}>
            重新读取
          </button>
        </p>
      ) : null}
      {mutation.isError ? (
        <p className="ml-form-error" role="alert">
          {diaryErrorMessage(mutation.error)}
        </p>
      ) : null}
      {success ? (
        <p className="ml-composer-success" role="status">
          {success}点击书脊，就能取出翻阅。
        </p>
      ) : null}
    </section>
  );
}
