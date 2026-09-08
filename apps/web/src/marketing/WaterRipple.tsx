import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";
import type { MotionMode } from "../hooks/useMotionPreference";
import { RIVER_PATH } from "./riverGeometry";

interface Ripple {
  id: number;
  x: number;
  y: number;
}

export function WaterRipple({
  mode,
  clipping,
  artworkFrame,
}: {
  mode: MotionMode;
  clipping: CSSProperties;
  artworkFrame: RefObject<HTMLDivElement | null>;
}) {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const visible = useRef(true);
  const last = useRef(Number.NEGATIVE_INFINITY);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const timers = useRef<Set<number>>(new Set());
  const hitTest = useRef<{
    context: CanvasRenderingContext2D;
    path: Path2D;
    bank: ImageData | null;
    bankImage: HTMLImageElement | null;
  } | null>(null);
  const clearTransient = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
    origin.current = null;
    last.current = Number.NEGATIVE_INFINITY;
    setRipples((current) => (current.length === 0 ? current : []));
  }, []);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 256;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const geometry = {
      context,
      path: new Path2D(RIVER_PATH),
      bank: null as ImageData | null,
      bankImage:
        artworkFrame.current?.querySelector<HTMLImageElement>(
          ".layer-bank img",
        ) ?? null,
    };
    hitTest.current = geometry;
    const bankImage = geometry.bankImage;
    const readBank = () => {
      geometry.bank = null;
      if (!bankImage?.naturalWidth) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bankImage, 0, 0, canvas.width, canvas.height);
      geometry.bank = context.getImageData(0, 0, canvas.width, canvas.height);
    };
    if (bankImage?.complete) readBank();
    bankImage?.addEventListener("load", readBank);
    return () => {
      bankImage?.removeEventListener("load", readBank);
      hitTest.current = null;
    };
  }, [artworkFrame]);

  useEffect(() => {
    const current = timers.current;
    const onVisibilityChange = () => {
      if (document.hidden) clearTransient();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible.current = entry?.isIntersecting ?? false;
            if (!visible.current) clearTransient();
          });
    if (root.current) observer?.observe(root.current);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const timer of current) window.clearTimeout(timer);
      current.clear();
    };
  }, [clearTransient]);

  useEffect(() => {
    clearTransient();
  }, [mode, clearTransient]);

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = origin.current;
    origin.current = null;
    if (
      mode !== "normal" ||
      document.hidden ||
      !visible.current ||
      !start ||
      Math.hypot(start.x - event.clientX, start.y - event.clientY) > 8 ||
      performance.now() - last.current < 200
    )
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const geometry = hitTest.current;
    if (!geometry?.context.isPointInPath(geometry.path, x, y)) return;
    if (geometry.bank && geometry.bankImage) {
      const { width, height, data } = geometry.bank;
      const bankBounds = geometry.bankImage.getBoundingClientRect();
      const bankX = (event.clientX - bankBounds.left) / bankBounds.width;
      const bankY = (event.clientY - bankBounds.top) / bankBounds.height;
      const column = Math.floor(bankX * width);
      const row = Math.floor(bankY * height);
      // The foreground bank is above the ripple visually; its alpha also
      // prevents a tap on a painted rock from creating hidden/partial rings.
      if (
        column >= 0 &&
        column < width &&
        row >= 0 &&
        row < height &&
        (data[(row * width + column) * 4 + 3] ?? 0) > 24
      )
        return;
    }
    last.current = performance.now();
    const ripple = {
      id: last.current,
      x: x * 100,
      y: y * 100,
    };
    setRipples((current) => [...current.slice(-2), ripple]);
    const timer = window.setTimeout(() => {
      setRipples((current) => current.filter((item) => item.id !== ripple.id));
      timers.current.delete(timer);
    }, 900);
    timers.current.add(timer);
  }
  return (
    <div
      ref={root}
      className="river-hit-region"
      style={clipping}
      aria-hidden="true"
      data-testid="river-water"
      onPointerDown={(event) => {
        origin.current =
          mode === "normal" && !document.hidden && visible.current
            ? { x: event.clientX, y: event.clientY }
            : null;
      }}
      onPointerCancel={() => {
        origin.current = null;
      }}
      onPointerUp={onPointerUp}
    >
      {mode === "normal"
        ? ripples.map((ripple) => (
            <span
              className="water-ripple"
              key={ripple.id}
              style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
            />
          ))
        : null}
    </div>
  );
}
