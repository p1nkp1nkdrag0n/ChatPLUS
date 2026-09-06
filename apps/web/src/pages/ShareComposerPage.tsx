import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { RelationshipArchiveEntryIdSchema } from "@personasim/contracts";
import { api, unwrapCharacter } from "../api/client";
import { ShareComposer } from "../components/archive/ShareComposer";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import { relationshipArchiveQueryKeys } from "../lib/relationshipArchive";

export default function ShareComposerPage() {
  const { characterId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const requestedLetterId = searchParams.get("letterId") || undefined;
  const requestedKeepsakeId = searchParams.get("keepsakeId") || undefined;
  const letterEntryIdResult = RelationshipArchiveEntryIdSchema.safeParse(
    requestedLetterId === undefined ? undefined : `letter:${requestedLetterId}`,
  );
  const keepsakeEntryIdResult = RelationshipArchiveEntryIdSchema.safeParse(
    requestedKeepsakeId === undefined
      ? undefined
      : `keepsake:${requestedKeepsakeId}`,
  );
  const requestedLetterEntryId = letterEntryIdResult.success
    ? letterEntryIdResult.data
    : undefined;
  const requestedKeepsakeEntryId = keepsakeEntryIdResult.success
    ? keepsakeEntryIdResult.data
    : undefined;
  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
    enabled: Boolean(characterId),
  });
  const archiveQuery = useQuery({
    queryKey: [
      ...relationshipArchiveQueryKeys.page(characterId, "correspondence"),
      "share-sources",
    ],
    queryFn: () =>
      api.relationshipArchive.list(characterId, {
        filter: "correspondence",
        includePreviewText: false,
        limit: 40,
      }),
    enabled: Boolean(characterId),
  });
  const keepsakesQuery = useQuery({
    queryKey: [
      ...relationshipArchiveQueryKeys.keepsakes(characterId),
      "share-sources",
    ],
    queryFn: () => api.keepsakes.list(characterId, { limit: 50 }),
    enabled: Boolean(characterId),
  });
  const exactLetterQuery = useQuery({
    queryKey: [
      ...relationshipArchiveQueryKeys.entry(
        characterId,
        requestedLetterEntryId ?? "",
      ),
      "share-source-metadata",
    ],
    queryFn: () =>
      api.relationshipArchive.list(characterId, {
        entryId: requestedLetterEntryId!,
        includePreviewText: false,
        limit: 1,
      }),
    enabled: Boolean(characterId && requestedLetterEntryId),
  });
  const exactKeepsakeQuery = useQuery({
    queryKey: [
      ...relationshipArchiveQueryKeys.entry(
        characterId,
        requestedKeepsakeEntryId ?? "",
      ),
      "share-source-metadata",
    ],
    queryFn: () =>
      api.relationshipArchive.list(characterId, {
        entryId: requestedKeepsakeEntryId!,
        limit: 1,
      }),
    enabled: Boolean(characterId && requestedKeepsakeEntryId),
  });
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const listedArchiveEntries = archiveQuery.data?.items ?? [];
  const exactLetterCandidate = exactLetterQuery.data?.items[0];
  const exactLetterEntry =
    exactLetterCandidate?.entryType === "letter" &&
    exactLetterCandidate.agentId === characterId &&
    exactLetterCandidate.letterId === requestedLetterId
      ? exactLetterCandidate
      : undefined;
  const archiveEntries =
    exactLetterEntry &&
    !listedArchiveEntries.some(
      (entry) =>
        entry.entryType === "letter" && entry.id === exactLetterEntry.id,
    )
      ? [...listedArchiveEntries, exactLetterEntry]
      : listedArchiveEntries;
  const listedKeepsakes = keepsakesQuery.data?.items ?? [];
  const exactKeepsakeCandidate = exactKeepsakeQuery.data?.items[0];
  const exactKeepsakeEntry =
    exactKeepsakeCandidate?.entryType === "keepsake" &&
    exactKeepsakeCandidate.agentId === characterId &&
    exactKeepsakeCandidate.keepsakeId === requestedKeepsakeId
      ? exactKeepsakeCandidate
      : undefined;
  const exactKeepsake = exactKeepsakeEntry
    ? {
        id: exactKeepsakeEntry.keepsakeId,
        agentId: exactKeepsakeEntry.agentId,
        title: exactKeepsakeEntry.title,
        kind: exactKeepsakeEntry.keepsakeKind,
        description: exactKeepsakeEntry.summary,
        status: "ready" as const,
        createdEffectiveAtUtc: exactKeepsakeEntry.effectiveAtUtc,
        thumbnailUrl: exactKeepsakeEntry.thumbnailUrl,
      }
    : undefined;
  const keepsakes =
    exactKeepsake &&
    !listedKeepsakes.some((keepsake) => keepsake.id === exactKeepsake.id)
      ? [...listedKeepsakes, exactKeepsake]
      : listedKeepsakes;
  const pending =
    characterQuery.isPending ||
    archiveQuery.isPending ||
    keepsakesQuery.isPending ||
    (requestedLetterEntryId !== undefined && exactLetterQuery.isPending) ||
    (requestedKeepsakeEntryId !== undefined && exactKeepsakeQuery.isPending);
  const error =
    characterQuery.error ??
    archiveQuery.error ??
    keepsakesQuery.error ??
    exactLetterQuery.error ??
    exactKeepsakeQuery.error;

  return (
    <div className="share-composer-page">
      <header className="archive-header share-page-header">
        <div>
          <Link
            className="archive-back-link"
            to={`/characters/${characterId}/relationship-archive`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回关系档案
          </Link>
          <h1>分享一段共同的回忆</h1>
          <p>选择信封、邮戳、等待天数与纪念物。正文必须由你手动开启。</p>
        </div>
        <span className="share-page-header__character">
          {character?.identity.name ?? "关系档案"}
        </span>
      </header>
      {pending ? <LoadingBlock label="正在准备本地分享工具…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {!pending && !error ? (
        <main className="share-composer-wrap">
          <ShareComposer
            key={`${characterId}:${requestedLetterId ?? ""}:${requestedKeepsakeId ?? ""}`}
            agentId={characterId}
            archiveEntries={archiveEntries}
            keepsakes={keepsakes}
            {...(requestedLetterId === undefined
              ? {}
              : { initialLetterId: requestedLetterId })}
            {...(requestedKeepsakeId === undefined
              ? {}
              : { initialKeepsakeId: requestedKeepsakeId })}
          />
        </main>
      ) : null}
    </div>
  );
}
