import { ArrowDown, ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { STORY_DIALOGUES, STORY_SCENES, storyFrame } from "../lib/story";
import { LoadingBlock } from "../components/Feedback";

export default function LandingPage() {
  const journey = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const retry = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState<number[]>([]);
  const [failed, setFailed] = useState(false);
  const [visibleState, setVisibleState] = useState(0);

  useEffect(() => {
    document.title = "Dearvale · 让相遇，慢慢成为故事";
    const root = journey.current;
    const canvas = stage.current;
    if (!root || !canvas) return;
    const layers = Array.from(
      canvas.querySelectorAll<HTMLElement>(".story-background"),
    );
    const states = Array.from(
      canvas.querySelectorAll<HTMLElement>(".story-state"),
    );
    const loaded = new Set<number>();
    const requested = new Set<number>();
    const errors = new Set<number>();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let frameId = 0;
    let lastState = -1;

    function schedule() {
      if (!disposed && !frameId) frameId = window.requestAnimationFrame(draw);
    }
    function load(index: number) {
      if (requested.has(index) || !STORY_SCENES[index]) return;
      requested.add(index);
      const picture = new Image();
      picture.src = `/dearvale/art/${STORY_SCENES[index].image}.png`;
      void picture
        .decode()
        .then(() => {
          if (disposed) return;
          loaded.add(index);
          errors.delete(index);
          setReady(Array.from(loaded));
          setFailed(errors.size > 0);
          schedule();
        })
        .catch(() => {
          if (!disposed) {
            errors.add(index);
            setFailed(true);
          }
        });
    }
    function draw() {
      frameId = 0;
      const distance = Math.max(1, root!.offsetHeight - window.innerHeight);
      const progress = (-root!.getBoundingClientRect().top / distance) * 5;
      const frame = storyFrame(progress, motion.matches);
      load(frame.currentScene);
      load(frame.nextScene);
      load(Math.min(4, frame.nextScene + 1));
      // Hold the previous complete frame until its replacement has decoded.
      if (!loaded.has(frame.currentScene)) return;
      const mix = loaded.has(frame.nextScene) ? frame.mix : 0;
      const actualState = mix >= 0.5 ? frame.next : frame.current;
      layers.forEach((layer, index) => {
        const weight =
          frame.currentScene === frame.nextScene
            ? Number(index === frame.currentScene)
            : index === frame.currentScene
              ? 1
              : index === frame.nextScene
                ? mix
                : 0;
        layer.style.opacity = String(weight);
        layer.style.zIndex = index === frame.nextScene ? "1" : "0";
      });
      states.forEach((element, index) => {
        const weight =
          frame.current === frame.next
            ? Number(index === frame.current)
            : index === frame.current
              ? 1 - mix
              : index === frame.next
                ? mix
                : 0;
        element.style.opacity = String(weight);
        element.style.setProperty(
          "--story-drift",
          `${motion.matches ? 0 : (1 - weight) * 8}px`,
        );
        element.inert = index !== actualState;
        element.setAttribute("aria-hidden", String(index !== actualState));
      });
      if (lastState !== actualState) {
        lastState = actualState;
        setVisibleState(actualState);
      }
    }
    retry.current = () => {
      for (const index of errors) {
        requested.delete(index);
        load(index);
      }
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    motion.addEventListener("change", schedule);
    load(0);
    load(1);
    schedule();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      motion.removeEventListener("change", schedule);
    };
  }, []);

  const goTo = (state: number) => {
    const root = journey.current;
    if (!root) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({
      top:
        root.offsetTop + ((root.offsetHeight - window.innerHeight) * state) / 5,
      behavior: reduced ? "instant" : "smooth",
    });
  };

  return (
    <div className="story-journey" ref={journey} data-testid="story-journey">
      <div className="story-stage" ref={stage} data-state={visibleState}>
        {STORY_SCENES.map((scene, index) => (
          <div
            key={scene.image}
            className="story-background"
            style={{ opacity: index === 0 ? 1 : 0 }}
          >
            {ready.includes(index) ? (
              <img
                src={`/dearvale/art/${scene.image}.png`}
                alt=""
                draggable={false}
              />
            ) : null}
          </div>
        ))}
        <div className="story-state story-opening" style={{ opacity: 1 }}>
          <h1>
            <img
              className="story-wordmark"
              src="/dearvale/art/wordmark.svg"
              alt="Dearvale"
            />
          </h1>
          <button
            type="button"
            className="story-scroll-cue"
            onClick={() => goTo(1)}
          >
            <span>滚动，开始相遇</span>
            <ArrowDown size={27} strokeWidth={1.6} />
          </button>
        </div>
        {STORY_DIALOGUES.map((dialogue, index) => (
          <section
            className={`story-state story-conversation story-conversation--${index + 1}`}
            key={dialogue[0]}
            style={{ opacity: 0 }}
            inert
            aria-hidden="true"
            aria-label={`${STORY_SCENES[Math.max(0, index)]!.name}的对话`}
          >
            <div className="story-dialogue">
              <p className="story-bubble story-bubble--first">{dialogue[0]}</p>
              <p className="story-bubble story-bubble--second">{dialogue[1]}</p>
            </div>
            {index === 4 ? (
              <Link className="story-start" to="/welcome">
                开始相遇 <ArrowRight size={19} />
              </Link>
            ) : null}
          </section>
        ))}
        {!ready.includes(0) ? (
          <div className="story-loading">
            <LoadingBlock label="风景正在展开…" />
          </div>
        ) : null}
        <nav className="story-progress" aria-label="场景导航">
          {STORY_SCENES.map((scene, index) => (
            <button
              type="button"
              key={scene.image}
              className={
                Math.max(0, visibleState - 1) === index ? "is-active" : ""
              }
              aria-label={`前往${scene.name}`}
              aria-current={
                Math.max(0, visibleState - 1) === index ? "step" : undefined
              }
              onClick={() => goTo(scene.state)}
            >
              <span />
            </button>
          ))}
        </nav>
        {failed ? (
          <button
            type="button"
            className="story-retry"
            onClick={() => retry.current()}
          >
            <RefreshCw size={14} /> 重新加载风景
          </button>
        ) : null}
      </div>
    </div>
  );
}
