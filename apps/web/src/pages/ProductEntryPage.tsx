import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api/client";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { readActiveCharacter } from "../lib/activeCharacter";
import { publishedUserCharacters } from "../lib/lastConversation";

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
  const characters = publishedUserCharacters(query.data.characters);
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
        title="描述你梦中的他/她"
        description="从一个名字开始，慢慢描绘一个会与你相遇的人。"
        action={
          <Link className="button button--primary" to="/create">
            描述你梦中的他/她
          </Link>
        }
      />
    </div>
  );
}
