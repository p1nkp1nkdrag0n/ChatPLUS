import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api/client";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { readActiveCharacter } from "../lib/activeCharacter";

export default function ProductEntryPage({
  kind,
}: {
  kind: "chat" | "mailbox";
}) {
  const query = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  if (query.isPending)
    return <LoadingBlock label="正在寻找熟悉的身影…" fullPage />;
  if (query.isError)
    return (
      <div className="page">
        <ErrorBlock error={query.error} />
      </div>
    );
  const characters = query.data.characters.filter(
    (character) => character.status === "published",
  );
  const character =
    characters.find((item) => item.id === readActiveCharacter()) ??
    characters[0];
  if (character)
    return (
      <Navigate
        replace
        to={`/characters/${character.id}/${kind === "chat" ? "chat" : "correspondence"}`}
      />
    );
  return (
    <div className="page">
      <EmptyState
        title="先认识一个角色"
        description="选择一个可以对话的角色，让故事从这里开始。"
        action={
          <Link className="button button--primary" to="/characters">
            前往角色库
          </Link>
        }
      />
    </div>
  );
}
