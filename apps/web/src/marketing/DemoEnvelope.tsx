import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { MotionMode } from "../hooks/useMotionPreference";
import { content } from "./content";

export function DemoEnvelope({ mode }: { mode: MotionMode }) {
  const [phase, setPhase] = useState<"closed" | "opening" | "readable">(
    "closed",
  );
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const visible = useRef(true);
  const openedOnce = useRef(false);
  const focusReading = useRef(false);
  const focusOpenButton = useRef(false);
  const openingTimer = useRef<number | undefined>(undefined);
  const clearOpeningTimer = useCallback(() => {
    if (openingTimer.current !== undefined) {
      window.clearTimeout(openingTimer.current);
      openingTimer.current = undefined;
    }
  }, []);

  useEffect(() => {
    const finishWithoutFocus = () => {
      focusReading.current = false;
      focusOpenButton.current = false;
      clearOpeningTimer();
      setPhase((current) => (current === "opening" ? "readable" : current));
    };
    const onVisibilityChange = () => {
      if (document.hidden) finishWithoutFocus();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible.current = entry?.isIntersecting ?? false;
            if (!visible.current) finishWithoutFocus();
          });
    if (root.current) observer?.observe(root.current);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearOpeningTimer();
    };
  }, [clearOpeningTimer]);

  useEffect(() => {
    if (phase !== "opening") return;
    if (mode !== "normal" || document.hidden || !visible.current) {
      if (document.hidden || !visible.current) focusReading.current = false;
      setPhase("readable");
      return;
    }
    openingTimer.current = window.setTimeout(() => {
      openingTimer.current = undefined;
      setPhase("readable");
    }, 600);
    return clearOpeningTimer;
  }, [phase, mode, clearOpeningTimer]);

  useEffect(() => {
    if (document.hidden || !visible.current) return;
    const focusIsWithinDemo =
      document.activeElement === document.body ||
      root.current?.contains(document.activeElement);
    if (phase === "readable" && focusReading.current) {
      focusReading.current = false;
      if (focusIsWithinDemo) title.current?.focus({ preventScroll: true });
    }
    if (phase === "closed" && focusOpenButton.current) {
      focusOpenButton.current = false;
      if (focusIsWithinDemo) openButton.current?.focus({ preventScroll: true });
    }
  }, [phase]);

  const open = () => {
    focusReading.current = true;
    const animate = mode === "normal" && !openedOnce.current;
    openedOnce.current = true;
    setPhase(animate ? "opening" : "readable");
  };

  return (
    <div className="demo-envelope" ref={root} data-phase={phase}>
      {phase === "readable" ? (
        <article className="demo-letter" aria-label={content.letters.demoLabel}>
          <p className="demo-label">{content.letters.demoLabel}</p>
          <h3 ref={title} tabIndex={-1}>
            {content.letters.demoSubject}
          </h3>
          <p className="demo-letter__body">{content.letters.demoBody}</p>
          <p className="demo-letter__note">
            合成内容，仅用于展示书信阅读体验。
          </p>
          <button
            className="site-text-link"
            onClick={() => {
              focusOpenButton.current = true;
              setPhase("closed");
            }}
          >
            <ArrowLeft size={15} /> 收起示例
          </button>
        </article>
      ) : (
        <>
          <div
            className="envelope-object"
            aria-hidden="true"
            data-layer="S03-ENVELOPE-BACK"
          >
            <div className="envelope-letter" data-layer="S03-LETTER" />
            <div className="envelope-front" data-layer="S03-ENVELOPE-FRONT" />
            <div className="envelope-flap" data-layer="S03-ENVELOPE-FLAP" />
            <img
              className="envelope-sprig"
              src="/art/early-summer/ui/botanical-mark.webp"
              alt=""
            />
          </div>
          <div className="envelope-action">
            {phase === "closed" ? (
              <button className="site-button" ref={openButton} onClick={open}>
                {content.letters.action}
                <ArrowRight size={17} />
              </button>
            ) : (
              <button
                className="site-button"
                onClick={() => setPhase("readable")}
              >
                {content.letters.skip}
                <ArrowRight size={17} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
