import { ArrowLeft, ArrowRight, BookOpen, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { RouteTransition } from "./RouteTransition";
import "./experience.css";

const REPOSITORY_URL = "https://github.com/p1nkp1nkdrag0n/ChatPLUS";

export default function StartPage() {
  return (
    <RouteTransition title="ChatPLUS · 开始使用">
      <main className="start-page">
        <header className="experience-header">
          <Link className="experience-brand" to="/about">
            ChatPLUS
          </Link>
          <Link className="experience-text-link" to="/about">
            <ArrowLeft size={14} aria-hidden="true" /> 返回产品介绍
          </Link>
        </header>
        <article className="start-guide">
          <h1 tabIndex={-1}>从一次相遇开始。</h1>
          <p className="start-lead">
            ChatPLUS 是一个单用户虚构角色对话
            Demo。你可以在本机运行，也可以为一位朋友部署独立实例。
          </p>
          <div className="start-entry">
            <div>
              <h2>已经启动这个实例？</h2>
              <p>进入角色列表，继续聊天，或创建你的第一位角色。</p>
            </div>
            <Link
              className="experience-button experience-button--primary"
              to="/welcome"
            >
              进入应用 <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <section className="start-section" aria-labelledby="start-local">
            <span className="start-section__number" aria-hidden="true">
              01
            </span>
            <div>
              <h2 id="start-local">在自己的电脑上开始</h2>
              <p>准备 Node.js 22–24 和 pnpm 11，在项目目录依次运行：</p>
              <pre aria-label="本地启动命令">
                <code>{"pnpm install\npnpm db:migrate\npnpm dev"}</code>
              </pre>
              <p>
                启动后，按终端显示的地址打开应用。默认 Fixture 演示不需要 API
                Key；对话是确定性流程示例。
              </p>
            </div>
          </section>
          <section className="start-section" aria-labelledby="start-character">
            <span className="start-section__number" aria-hidden="true">
              02
            </span>
            <div>
              <h2 id="start-character">认识角色，写下第一句话</h2>
              <p>
                默认安装会提供可体验的角色。也可以填写姓名、世界、身份与少量特质创建原创角色，或从
                .txt、.md、.srt 和粘贴文本导入（最多 500 KB）。
              </p>
              <p>
                在编辑器检查设定并点击“发布并激活”，再进入对话。目标与矛盾可以留空，相处不必从一个人生难题开始。
              </p>
            </div>
          </section>
          <section className="start-section" aria-labelledby="start-hosting">
            <span className="start-section__number" aria-hidden="true">
              03
            </span>
            <div>
              <h2 id="start-hosting">为朋友留一个独立的空间</h2>
              <p>
                自托管使用 Docker 与
                Caddy，每个实例拥有独立数据库、密钥和访问认证。完整部署、书信启用与备份步骤请阅读项目指南。
              </p>
              <a
                className="experience-text-link"
                href={`${REPOSITORY_URL}/blob/main/docs/SELF_HOSTING.md`}
                target="_blank"
                rel="noreferrer"
              >
                阅读自托管指南 <ExternalLink size={14} aria-hidden="true" />
              </a>
            </div>
          </section>
          <aside className="start-data-note">
            <BookOpen size={20} aria-hidden="true" />
            <p>
              角色与记录存放在运行实例的数据库中。使用真实模型时，必要上下文会发送给你配置的模型供应商；默认
              Fixture 演示无需发送给外部模型。
            </p>
          </aside>
          <footer className="start-guide__footer">
            <Link className="experience-text-link" to="/about">
              回到初夏的风里
            </Link>
            <a
              className="experience-text-link"
              href={`${REPOSITORY_URL}#readme`}
              target="_blank"
              rel="noreferrer"
            >
              完整使用文档 <ExternalLink size={14} aria-hidden="true" />
            </a>
          </footer>
        </article>
      </main>
    </RouteTransition>
  );
}
