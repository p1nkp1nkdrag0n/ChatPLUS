import { FileText, Sparkles, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, unwrapCharacter } from "../api/client";
import type { SimulationTier } from "../api/types";
import { ErrorBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { rememberActiveCharacter } from "../lib/activeCharacter";

const MAX_BYTES = 500 * 1024;
const ACCEPTED_EXTENSIONS = [".txt", ".md", ".srt"];

export default function CharacterImportPage() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    name: "",
    workTitle: "",
    storyStage: "",
    tier: "high_fidelity" as SimulationTier,
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    material: "",
    fileName: "",
  });
  const [fileError, setFileError] = useState<string>();
  const mutation = useMutation({
    mutationFn: api.characters.import,
    onSuccess: (result) => {
      const character = unwrapCharacter(result);
      rememberActiveCharacter(character.id);
      void navigate(`/characters/${character.id}/edit`);
    },
  });

  const loadFile = async (file: File) => {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      setFileError("第一版只支持 .txt、.md 和 .srt 文件。");
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError("文件超过 500 KB，请先截取与角色最相关的材料。");
      return;
    }
    setFileError(undefined);
    const material = await file.text();
    setForm((current) => ({ ...current, material, fileName: file.name }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const bytes = new TextEncoder().encode(form.material).byteLength;
    if (bytes > MAX_BYTES) {
      setFileError("文本超过 500 KB，请精简后重试。");
      return;
    }
    mutation.mutate(form);
  };

  return (
    <div className="page page--form">
      <PageHeader
        title="导入作品角色"
        description="从正典文本抽取可追溯设定；明确事实和模型推断会被分开标记。"
        actions={
          <Link className="button button--ghost" to="/create">
            <Sparkles size={16} aria-hidden="true" /> 改为原创角色
          </Link>
        }
      />
      <form className="import-layout" onSubmit={submit}>
        <section className="form-document">
          <div className="field-grid field-grid--two">
            <label className="field">
              <span>角色名称</span>
              <input
                required
                maxLength={120}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>作品名称</span>
              <input
                required
                maxLength={200}
                value={form.workTitle}
                onChange={(event) =>
                  setForm({ ...form, workTitle: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>角色所处的剧情阶段</span>
            <input
              required
              maxLength={240}
              value={form.storyStage}
              onChange={(event) =>
                setForm({ ...form, storyStage: event.target.value })
              }
              placeholder="例如：第一季结局之后、尚未得知最终真相"
            />
          </label>

          <div className="material-toolbar">
            <div>
              <h2>角色材料</h2>
              <p>粘贴文本，或选择一个不超过 500 KB 的文件。</p>
            </div>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept=".txt,.md,.srt,text/plain,text/markdown,application/x-subrip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
            <button
              className="button button--ghost"
              type="button"
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={16} aria-hidden="true" /> 选择文件
            </button>
          </div>
          {form.fileName ? (
            <div className="selected-file">
              <FileText size={17} aria-hidden="true" />
              <span>{form.fileName}</span>
              <button
                type="button"
                onClick={() => setForm({ ...form, fileName: "", material: "" })}
              >
                移除
              </button>
            </div>
          ) : null}
          <label className="field">
            <span className="sr-only">角色材料正文</span>
            <textarea
              className="material-textarea"
              required
              rows={20}
              value={form.material}
              onChange={(event) =>
                setForm({ ...form, material: event.target.value, fileName: "" })
              }
              placeholder="在这里粘贴小说片段、剧本、字幕或官方角色设定……"
            />
          </label>
          {fileError ? <p className="field-error">{fileError}</p> : null}
        </section>
        <aside className="form-inspector">
          <div className="form-inspector__sticky">
            <h2>抽取设置</h2>
            <label className="field field--compact">
              <span>模拟等级</span>
              <select
                value={form.tier}
                onChange={(event) =>
                  setForm({
                    ...form,
                    tier: event.target.value as SimulationTier,
                  })
                }
              >
                <option value="lightweight">轻量模拟</option>
                <option value="daily">日常模拟</option>
                <option value="high_fidelity">拟真模拟</option>
              </select>
            </label>
            <label className="field field--compact">
              <span>角色时区</span>
              <input
                required
                value={form.timezone}
                onChange={(event) =>
                  setForm({ ...form, timezone: event.target.value })
                }
              />
            </label>
            <div className="provenance-preview">
              <span className="thread-node" />
              <div>
                <strong>来源会被保留</strong>
                <p>
                  直接证据、强推断与合成补全不会混为一谈。运行时也不会注入整份原文。
                </p>
              </div>
            </div>
            {mutation.isError ? <ErrorBlock error={mutation.error} /> : null}
            <button
              className="button button--primary button--wide"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "正在抽取角色…" : "抽取并生成草稿"}
            </button>
          </div>
        </aside>
      </form>
    </div>
  );
}
