import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { MotionMode } from "../hooks/useMotionPreference";
import { art } from "./content";

interface SceneProps {
  id: string;
  scene: string;
  className: string;
  mode: MotionMode;
  labelledBy: string;
  children: ReactNode;
}

export function Scene({
  id,
  scene,
  className,
  mode,
  labelledBy,
  children,
}: SceneProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let visible = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      const active = visible && !document.hidden && mode === "normal";
      node.dataset["active"] = String(active);
      if (mode !== "normal") {
        node.style.setProperty("--travel", "0px");
        return;
      }
      if (!visible || document.hidden) return;
      const rect = node.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const start = Math.max(0, top - window.innerHeight);
      const end = top + rect.height;
      const progress = Math.max(
        0,
        Math.min(1, (window.scrollY - start) / (end - start)),
      );
      const limit = window.innerWidth <= 700 ? 12 : 48;
      node.style.setProperty("--progress", String(progress));
      node.style.setProperty("--travel", `${-progress * limit}px`);
    };
    const requestUpdate = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? false;
        requestUpdate();
      },
      { rootMargin: "0px", threshold: 0 },
    );
    observer.observe(node);
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    document.addEventListener("visibilitychange", requestUpdate);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      document.removeEventListener("visibilitychange", requestUpdate);
    };
  }, [mode]);
  return (
    <section
      ref={ref}
      id={id}
      className={`scene ${className}`}
      data-scene={scene}
      data-active="false"
      aria-labelledby={labelledBy}
    >
      {children}
    </section>
  );
}

interface LayerProps {
  name: string;
  src: string;
  className?: string;
  style?: CSSProperties;
  eager?: boolean;
  children?: ReactNode;
}

export function Layer({
  name,
  src,
  className = "",
  style,
  eager = false,
  children,
}: LayerProps) {
  return (
    <div
      className={`scene-layer ${className}`}
      data-layer={name}
      aria-hidden="true"
      style={style}
    >
      <picture>
        {!src.startsWith("ui/") ? (
          <source
            media="(max-width: 700px)"
            srcSet={`${art}/${src.replace(".webp", "-mobile.webp")}`}
          />
        ) : null}
        <img
          src={`${art}/${src}`}
          alt=""
          draggable={false}
          decoding="async"
          loading={eager ? "eager" : "lazy"}
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
          {...(eager ? { fetchPriority: "high" as const } : {})}
        />
      </picture>
      {children}
    </div>
  );
}

export function Flower({
  side,
  mode,
}: {
  side: "left" | "right";
  mode: MotionMode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || mode !== "normal" || !matchMedia("(pointer: fine)").matches)
      return;
    let last = 0;
    let timer = 0;
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch" || performance.now() - last < 120)
        return;
      const bounds = node.getBoundingClientRect();
      const x = event.clientX - (bounds.left + bounds.width / 2);
      const y = event.clientY - (bounds.top + bounds.height * 0.55);
      if (Math.hypot(x, y) > 110) return;
      last = performance.now();
      node.style.setProperty("--wind", `${x < 0 ? 4 : -4}deg`);
      clearTimeout(timer);
      timer = window.setTimeout(
        () => node.style.setProperty("--wind", "0deg"),
        180,
      );
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointer);
      clearTimeout(timer);
      node.style.setProperty("--wind", "0deg");
    };
  }, [mode]);
  return (
    <div
      ref={ref}
      className={`meadow-flower meadow-flower--${side}`}
      aria-hidden="true"
    >
      <Layer
        name={`S01-FLOWER-${side.toUpperCase()}`}
        src="ui/botanical-mark.webp"
        className="flower-sprig"
        eager
      />
    </div>
  );
}
