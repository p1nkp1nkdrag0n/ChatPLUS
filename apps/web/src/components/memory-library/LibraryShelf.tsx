import type { CSSProperties } from "react";
import type { DiaryVolume } from "../../api/diaries";
import { bookColor, monthTitle, volumeKey } from "./pagination";

export function LibraryShelf({
  volumes,
  phoneMode = false,
  selectedKey,
  onSelect,
}: {
  volumes: readonly DiaryVolume[];
  phoneMode?: boolean;
  selectedKey?: string;
  onSelect: (volume: DiaryVolume, button: HTMLButtonElement) => void;
}) {
  const grouped = new Map<string, DiaryVolume[]>();
  for (const volume of [...volumes].sort((a, b) =>
    b.month.localeCompare(a.month),
  )) {
    const key = `${volume.agentId}:${volume.month.slice(0, 4)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), volume]);
  }
  const rows = [...grouped.entries()].flatMap(([key, books]) => {
    const chunks: Array<{ key: string; books: DiaryVolume[] }> = [];
    for (let start = 0; start < books.length; start += 6)
      chunks.push({
        key: `${key}:${start}`,
        books: books.slice(start, start + 6),
      });
    return chunks;
  });
  return (
    <div className="ml-cabinet" aria-label="月度手记书架">
      {rows.map(({ key, books }) => (
        <section className="ml-shelf-row" key={key}>
          <div className="ml-row-heading">
            <h2>{books[0]!.characterName}的手记</h2>
            <span>{books[0]!.month.slice(0, 4)}</span>
          </div>
          <div
            className="ml-books"
            {...(phoneMode
              ? {
                  role: "region",
                  tabIndex: 0,
                  "aria-label": `${books[0]!.characterName}的${books[0]!.month.slice(0, 4)}年月度手记，可左右滑动`,
                }
              : {})}
          >
            {books.map((volume, index) => {
              const id = volumeKey(volume.agentId, volume.month);
              return (
                <div
                  key={id}
                  className={`ml-book-slot${selectedKey === id ? " is-out" : ""}`}
                  style={
                    {
                      "--book-height": `${214 + (index % 3) * 7}px`,
                      "--cover": bookColor(volume.agentId),
                    } as CSSProperties
                  }
                >
                  <button
                    type="button"
                    className={`ml-spine-button${selectedKey === id ? " is-out" : ""}`}
                    data-volume={id}
                    onClick={(event) => onSelect(volume, event.currentTarget)}
                    aria-label={`取出${volume.characterName}，${volume.month.slice(0, 4)}年${Number(volume.month.slice(5))}月的手记`}
                  >
                    <span className="ml-spine-year">
                      {volume.month.slice(0, 4)}
                    </span>
                    <span className="ml-spine-title">
                      {monthTitle(volume.month)}手记
                    </span>
                    <span className="ml-spine-writer">
                      {volume.characterName}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
