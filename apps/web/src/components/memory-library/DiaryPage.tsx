import type { DiaryPageData } from "./pagination";

export function DiaryPage({
  page,
  number,
  side,
  characterName,
}: {
  page: DiaryPageData | null | undefined;
  number: number;
  side: "left" | "right";
  characterName: string;
}) {
  return (
    <article className={`ml-paper ${side}`} aria-label={`第 ${number} 页`}>
      <div className="ml-page-flow">
        {page ? (
          <>
            <div className={page.first ? "ml-page-date" : "ml-running-head"}>
              {page.first
                ? page.entryDate.replaceAll("-", " · ")
                : `${characterName}的手记 · 续`}
            </div>
            {page.first ? (
              <h3 className="ml-page-title">{page.title}</h3>
            ) : null}
            <div className="ml-page-body">{page.body}</div>
          </>
        ) : (
          <div className="ml-blank-page" aria-label="留白页">
            ✧
          </div>
        )}
      </div>
      {page?.last ? (
        <span className="ml-signature">—— {characterName}</span>
      ) : null}
      <span className="ml-page-number">{number}</span>
    </article>
  );
}
