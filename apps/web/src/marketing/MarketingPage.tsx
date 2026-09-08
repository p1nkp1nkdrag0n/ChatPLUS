import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, Leaf } from "lucide-react";
import { Link, useLocation, useNavigationType } from "react-router-dom";
import {
  useMotionPreference,
  type MotionPreference,
} from "../hooks/useMotionPreference";
import { content, getStartDestination } from "./content";
import { Scene, Layer, Flower } from "./Scene";
import { DemoEnvelope } from "./DemoEnvelope";
import { RiverSurface } from "./RiverSurface";
import "./marketing.css";

const destination = getStartDestination(import.meta.env["VITE_APP_URL"]);
function StartLink({ small = false }: { small?: boolean }) {
  const className = `site-button${small ? " site-button--small" : ""}`;
  const children = (
    <>
      {content.hero.primaryAction}
      {!small ? <ArrowRight size={18} aria-hidden="true" /> : null}
    </>
  );
  return destination.startsWith("/") ? (
    <Link className={className} to={destination}>
      {children}
    </Link>
  ) : (
    <a className={className} href={destination}>
      {children}
    </a>
  );
}

export default function MarketingPage() {
  const { preference, mode, updatePreference } = useMotionPreference();
  const { hash } = useLocation();
  const navigationType = useNavigationType();
  const [later, setLater] = useState(false);
  useEffect(() => {
    const previous = document.title;
    document.title = "ChatPLUS · 让相遇，慢慢成为故事";
    if (navigationType !== "POP" && !hash) {
      window.scrollTo({ top: 0, behavior: "instant" });
      document.getElementById("site-title")?.focus({ preventScroll: true });
    }
    return () => {
      document.title = previous;
    };
  }, [hash, navigationType]);
  return (
    <main className="marketing-page" data-motion={mode}>
      <a className="site-skip" href="#site-title">
        跳至正文
      </a>
      <header className="site-header">
        <a href="#sky-meadow" className="site-brand" aria-label="ChatPLUS 首页">
          ChatPLUS
        </a>
        <nav aria-label="官网导航">
          <a href="#forest-stream">产品介绍</a>
          <Link to="/start">使用文档</Link>
          <StartLink small />
        </nav>
      </header>
      <Scene
        id="sky-meadow"
        scene="S01"
        className="scene--meadow"
        mode={mode}
        labelledBy="site-title"
      >
        <Layer name="S01-SKY" src="s01/sky.webp" className="layer-sky" eager />
        <Layer
          name="S01-CLOUD-FAR"
          src="s01/cloud.webp"
          className="layer-cloud layer-cloud--far"
          eager
        />
        <Layer
          name="S01-CLOUD-NEAR"
          src="s01/cloud.webp"
          className="layer-cloud layer-cloud--near"
          eager
        />
        <Layer
          name="S01-MOUNTAIN"
          src="s01/mountain.webp"
          className="layer-mountain"
          eager
        />
        <Layer
          name="S01-MEADOW"
          src="s01/meadow.webp"
          className="layer-meadow"
          eager
        />
        <Layer
          name="S01-BRANCH"
          src="s01/branch.webp"
          className="layer-branch"
          eager
        />
        <Flower side="left" mode={mode} />
        <Flower side="right" mode={mode} />
        <div className="scene-copy hero-copy">
          <h1 id="site-title" tabIndex={-1}>
            让相遇，
            <br />
            慢慢成为故事。
          </h1>
          <p>
            与拥有自己生活脉络的虚构角色对话，
            <br className="desktop-break" />
            让记忆、书信与共同经历逐渐积累。
          </p>
          <div className="scene-actions">
            <StartLink />
            <a className="site-text-link" href="#forest-stream">
              {content.hero.secondaryAction}
            </a>
          </div>
        </div>
        <a className="scene-scroll" href="#forest-stream">
          循着风，往下看看
          <ArrowDown size={17} aria-hidden="true" />
        </a>
        <span className="scene-pagination" aria-hidden="true">
          01 <i /> 04
        </span>
      </Scene>
      <Scene
        id="forest-stream"
        scene="S02"
        className="scene--forest"
        mode={mode}
        labelledBy="memory-title"
      >
        <Layer
          name="S02-FOREST-BACK"
          src="s02/forest.webp"
          className="layer-forest"
        />
        <RiverSurface mode={mode} />
        <Layer
          name="S02-CANOPY"
          src="s01/branch.webp"
          className="layer-forest-canopy"
        />
        <div className="scene-copy forest-copy">
          <p className="chapter-number" aria-label="第二章">
            02
            <span />
            记得，便有了后来
          </p>
          <h2 id="memory-title">
            不只是回答你，
            <br />
            也记住你说过的话。
          </h2>
          <p>{content.memory.description}</p>
          <div
            className="conversation-demo"
            aria-label={content.memory.demoLabel}
          >
            <p className="demo-label">{content.memory.demoLabel}</p>
            <div className="demo-messages" aria-live="polite">
              {(later
                ? [
                    ...content.memory.initialMessages,
                    ...content.memory.laterMessages,
                  ]
                : content.memory.initialMessages
              ).map((message, index) => (
                <div
                  className={`demo-message demo-message--${message.role}`}
                  key={index}
                >
                  <span>{message.role === "user" ? "你" : "对方"}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
            <button
              className="site-text-link"
              onClick={() => setLater(!later)}
              aria-expanded={later}
            >
              {later ? "收起后续对话" : content.memory.revealAction}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <p className="demo-disclaimer">{content.memory.disclaimer}</p>
          </div>
        </div>
        <span className="scene-pagination" aria-hidden="true">
          02 <i /> 04
        </span>
      </Scene>
      <Scene
        id="writing-desk"
        scene="S03"
        className="scene--writing"
        mode={mode}
        labelledBy="letters-title"
      >
        <Layer name="S03-TABLE" src="s03/table.webp" className="layer-table" />
        <Layer name="S03-BOOK" src="s03/book.webp" className="layer-book" />
        <Layer name="S03-QUILL" src="s03/quill.webp" className="layer-quill" />
        <Layer
          name="S03-SPRIG"
          src="ui/botanical-mark.webp"
          className="layer-desk-sprig"
        />
        <div className="scene-copy writing-copy">
          <p className="chapter-number" aria-label="第三章">
            03
            <span />
            书信与往事
          </p>
          <h2 id="letters-title">
            有些话，
            <br />
            值得慢慢抵达。
          </h2>
          <p>{content.letters.description}</p>
          <DemoEnvelope mode={mode} />
        </div>
        <span className="scene-pagination" aria-hidden="true">
          03 <i /> 04
        </span>
      </Scene>
      <Scene
        id="ocean"
        scene="S04"
        className="scene--ocean"
        mode={mode}
        labelledBy="ocean-title"
      >
        <Layer name="S04-SKY" src="s01/sky.webp" className="layer-sky" />
        <Layer
          name="S04-CLOUD"
          src="s01/cloud.webp"
          className="layer-cloud layer-cloud--ocean"
        />
        <Layer name="S04-SEA" src="s04/sea.webp" className="layer-sea" />
        <Layer name="S04-COAST" src="s04/coast.webp" className="layer-coast" />
        <Layer
          name="S04-GRASS"
          src="s01/meadow.webp"
          className="layer-ocean-grass"
        />
        <Layer
          name="S04-BRANCH"
          src="s01/branch.webp"
          className="layer-ocean-branch"
        />
        <div className="scene-copy ocean-copy">
          <p className="chapter-number" aria-label="第四章">
            04
            <span />
            往后，还有很多可能
          </p>
          <h2 id="ocean-title">
            故事不必<span className="ocean-title-rest">一开始就完整。</span>
          </h2>
          <p>{content.ocean.description}</p>
          <div className="scene-actions">
            <StartLink />
            <Link className="site-text-link" to="/start">
              {content.ocean.secondaryAction}
            </Link>
          </div>
        </div>
        <span className="scene-pagination" aria-hidden="true">
          04 <i /> 04
        </span>
      </Scene>
      <footer className="site-footer">
        <a className="site-brand" href="#sky-meadow">
          ChatPLUS
        </a>
        <p>让记忆、书信与共同经历逐渐积累。</p>
        <label className="motion-choice">
          <Leaf size={14} aria-hidden="true" />
          <span>场景动态</span>
          <select
            value={preference}
            onChange={(event) =>
              updatePreference(event.target.value as MotionPreference)
            }
          >
            <option value="auto">跟随系统</option>
            <option value="reduced">减少动态</option>
            <option value="still">关闭场景动态</option>
          </select>
        </label>
        <Link to="/start">使用文档</Link>
      </footer>
    </main>
  );
}
