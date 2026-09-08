import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { api, unwrapList } from "../api/client";
import type { CharacterSummary } from "../api/types";
import { LoadingBlock } from "../components/Feedback";
import {
  clearActiveCharacter,
  readActiveCharacter,
} from "../lib/activeCharacter";
import { readEntryPreferences, resolveReturnRoute } from "./entryPreferences";

export default function EntryPage() {
  const [entry] = useState(readEntryPreferences);
  const [activeCharacterId] = useState(readActiveCharacter);
  const isReturning = Boolean(entry || activeCharacterId);
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
    enabled: isReturning,
    refetchOnMount: "always",
  });
  const characters = charactersQuery.data
    ? unwrapList<CharacterSummary>(charactersQuery.data, "characters")
    : [];
  const invalidActiveCharacter = Boolean(
    charactersQuery.isSuccess &&
    !charactersQuery.isFetching &&
    activeCharacterId &&
    !characters.some(
      (character) =>
        character.id === activeCharacterId && character.status === "published",
    ),
  );
  useEffect(() => {
    if (invalidActiveCharacter) clearActiveCharacter();
  }, [invalidActiveCharacter]);

  if (!isReturning) return <Navigate to="/welcome" replace />;
  if (charactersQuery.isPending || charactersQuery.isFetching) {
    return <LoadingBlock label="正在回到你的故事…" fullPage />;
  }
  if (charactersQuery.isError) return <Navigate to="/characters" replace />;
  return (
    <Navigate
      to={resolveReturnRoute(characters, entry?.lastRoute, activeCharacterId)}
      replace
    />
  );
}
