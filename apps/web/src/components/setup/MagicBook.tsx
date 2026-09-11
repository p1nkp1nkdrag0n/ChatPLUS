import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { BookMotion } from "../../hooks/useBookTurn";

const ART = "/dearvale/art/setup/";

function WandIllustration({ success = false }: { success?: boolean }) {
  return (
    <div
      className={`setup-illustration${success ? " setup-illustration--success" : ""}`}
    >
      <img src={`${ART}wand.png`} alt="法杖、魔法书与雏菊的水彩插画" />
      {success ? (
        <span className="setup-wand-glint" aria-hidden="true" />
      ) : null}
    </div>
  );
}

export function MagicBook({
  motion,
  onTurnEnd,
  onRevealEnd,
  children,
}: {
  motion: BookMotion;
  onTurnEnd: () => void;
  onRevealEnd: () => void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const leaf = useRef<HTMLDivElement>(null);
  const turning = motion.phase === "turning";
  useLayoutEffect(() => {
    const node = leaf.current;
    if (!node) return;
    if (turning) {
      const bounds = node.getBoundingClientRect();
      node.style.setProperty("--turn-width", `${bounds.width}px`);
      node.style.setProperty("--turn-height", `${bounds.height}px`);
    } else {
      node.style.removeProperty("--turn-width");
      node.style.removeProperty("--turn-height");
    }
  }, [turning]);
  useLayoutEffect(() => {
    if (motion.phase !== "idle") return;
    const title = frame.current?.querySelector<HTMLElement>(
      "[data-step-heading]",
    );
    title?.focus({ preventScroll: true });
  }, [motion.phase, motion.step]);
  return (
    <div className="setup-book-viewport">
      <div
        ref={frame}
        className="setup-book"
        data-testid="setup-book"
        data-phase={motion.phase}
        data-direction={motion.direction}
      >
        <img
          className="setup-book-base"
          src={`${ART}book.png`}
          alt=""
          fetchPriority="high"
        />
        <div className="setup-left-page">
          <WandIllustration success={motion.step === "success"} />
        </div>
        <div className="setup-mobile-paper" aria-hidden="true" />
        <div className="setup-mobile-illustration">
          <WandIllustration success={motion.step === "success"} />
        </div>
        <div className="setup-page-underlay" aria-hidden="true" />
        <div
          ref={leaf}
          className="setup-leaf"
          data-testid={turning ? "turning-page" : undefined}
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.animationName.startsWith("setup-leaf-")
            )
              onTurnEnd();
          }}
        >
          <div
            className="setup-leaf-front"
            inert={motion.phase !== "idle" || undefined}
            aria-hidden={turning || undefined}
          >
            <div className="setup-leaf-texture" aria-hidden="true" />
            <div
              className="setup-form"
              key={motion.step}
              onAnimationEnd={(event) => {
                if (
                  event.target === event.currentTarget &&
                  event.animationName === "setup-reveal"
                )
                  onRevealEnd();
              }}
            >
              {children}
            </div>
          </div>
          {turning ? (
            <div className="setup-leaf-back" aria-hidden="true" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
