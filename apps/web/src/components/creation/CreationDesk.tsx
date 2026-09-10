import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CREATION_TITLE } from "../../lib/characterInterview";

export type PenMotion = "idle" | "writing" | "dipping";

export function CreationDesk({
  children,
  motion = "idle",
  penPoint,
  preview = false,
  onPaperClick,
}: {
  children: ReactNode;
  motion?: PenMotion;
  penPoint?: { x: number; y: number };
  preview?: boolean;
  onPaperClick?: () => void;
}) {
  return (
    <main
      className={`creation-page${preview ? " creation-page--preview" : ""}`}
    >
      <div
        className="creation-stage"
        data-testid="creation-desk"
        data-motion={motion}
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
          {children}
        </div>
      </div>
    </main>
  );
}
