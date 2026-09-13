import type { DiaryVolume } from "../../api/diaries";
import { monthTitle } from "./pagination";

export function BookCoverFace({ volume }: { volume: DiaryVolume }) {
  return (
    <>
      <span className="ml-cover-year">
        {volume.month.slice(0, 4)} · VOL {volume.month.slice(5)}
      </span>
      <span className="ml-cover-title">{monthTitle(volume.month)}手记</span>
      <span className="ml-cover-rule" />
      <span className="ml-cover-writer">{volume.characterName}</span>
      <span className="ml-cover-subtitle">记下你说给我听的日子</span>
    </>
  );
}
