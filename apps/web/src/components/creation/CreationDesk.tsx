import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { CREATION_TITLE } from "../../lib/characterInterview";

export type PenMotion = "idle" | "writing" | "dipping";

export function CreationDesk({
  children,
  motion = "idle",
  penPoint,
  preview = false,
  lifted = false,
  onPaperClick,
}: {
  children: ReactNode;
  motion?: PenMotion;
  penPoint?: { x: number; y: number };
  preview?: boolean;
  lifted?: boolean;
  onPaperClick?: () => void;
}) {
  const deskPaper = useRef<HTMLImageElement>(null);
  const readingPaper = useRef<HTMLDivElement>(null);
  const [liftOrigin, setLiftOrigin] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!lifted || !readingPaper.current) return;
    const target = readingPaper.current.getBoundingClientRect();
    const source = deskPaper.current?.getBoundingClientRect();
    const visiblePaper = source && source.width > 0 && source.height > 0;
    setLiftOrigin({
      "--paper-lift-x": `${visiblePaper ? source.x + source.width / 2 - target.x - target.width / 2 : 0}px`,
      "--paper-lift-y": `${visiblePaper ? source.y + source.height / 2 - target.y - target.height / 2 : window.innerHeight * 0.3}px`,
      "--paper-lift-scale": visiblePaper
        ? Math.min(1.35, source.width / target.width)
        : 0.92,
    } as CSSProperties);
  }, [lifted]);
  return (
    <main
      className={`creation-page${preview ? " creation-page--preview" : ""}${lifted ? " creation-page--reading" : ""}`}
    >
      <div
        className="creation-stage"
        data-testid="creation-desk"
        data-motion={motion}
        aria-hidden={lifted || undefined}
        inert={lifted}
      >
        <img
          className="creation-background"
          src="/dearvale/art/creation/scene.png"
          alt=""
          fetchPriority="high"
        />
        <header className="creation-header">
          <Link to="/welcome" className="creation-brand">
            Dearvale
          </Link>
          <Link to="/welcome" className="creation-leave">
            暂存离开
          </Link>
        </header>
        <h1 className="creation-title">{CREATION_TITLE}</h1>
        <img
          ref={deskPaper}
          className={`creation-paper${motion === "dipping" ? " creation-paper--turning" : ""}`}
          src="/dearvale/art/creation/paper.png"
          alt=""
          onClick={onPaperClick}
        />
        <img
          className="creation-ink"
          src="/dearvale/art/creation/ink.png"
          alt=""
        />
        <div
          className={`creation-quill creation-quill--${motion}`}
          aria-hidden="true"
          style={
            motion === "writing" && penPoint
              ? { left: `${penPoint.x}%`, top: `${penPoint.y}%` }
              : undefined
          }
        >
          <img src="/dearvale/art/creation/quill.png" alt="" />
        </div>
        <div
          className={`creation-paper-content${preview ? " creation-paper-content--preview" : ""}`}
        >
          {lifted ? null : children}
        </div>
      </div>
      {lifted ? (
        <div className="creation-reading-layer">
          <div className="creation-reading-backdrop" aria-hidden="true" />
          <Link to="/welcome" className="creation-reading-leave">
            暂存离开
          </Link>
          <div
            ref={readingPaper}
            className={`creation-reading-paper${liftOrigin ? " creation-reading-paper--lifting" : ""}`}
            style={liftOrigin}
            data-testid="biography-paper"
            role="region"
            aria-label="人物小传"
          >
            <span className="creation-reading-caption">人物小传</span>
            {children}
          </div>
        </div>
      ) : null}
    </main>
  );
}
