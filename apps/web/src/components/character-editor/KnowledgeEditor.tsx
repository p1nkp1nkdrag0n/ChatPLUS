import type { CharacterSpec } from "../../api/types";
import type { SelectedField } from "./types";
import { EditableStringList, EditorSectionHeading } from "./EditorFields";

export function KnowledgeEditor({
  spec,
  onChange,
  onSelect,
}: {
  spec: CharacterSpec;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
}) {
  const update = (knowledge: CharacterSpec["knowledge"]) =>
    onChange({ ...spec, knowledge });
  return (
    <section>
      <EditorSectionHeading
        title="知识与边界"
        description="把确定事实、不确定认知和禁止越界的元知识分开管理。"
      />
      <div className="knowledge-editor-grid">
        <EditableStringList
          title="确定知道"
          description="角色可以作为事实使用的设定。"
          values={spec.knowledge.knownFacts}
          placeholder="添加一条确定事实"
          multiline
          onSelect={(index) =>
            onSelect({
              path: `knowledge.knownFacts.${index}`,
              label: "确定事实",
            })
          }
          onChange={(knownFacts) => update({ ...spec.knowledge, knownFacts })}
        />
        <EditableStringList
          title="尚不确定"
          description="角色应保留态度、避免当作事实的内容。"
          values={spec.knowledge.uncertainFacts}
          placeholder="添加一条不确定信息"
          multiline
          onSelect={(index) =>
            onSelect({
              path: `knowledge.uncertainFacts.${index}`,
              label: "不确定信息",
            })
          }
          onChange={(uncertainFacts) =>
            update({ ...spec.knowledge, uncertainFacts })
          }
        />
        <EditableStringList
          title="禁止的元知识"
          description="角色不应知道的系统、创作者或世界外信息。"
          values={spec.knowledge.forbiddenMetaKnowledge}
          placeholder="添加一条知识边界"
          multiline
          onSelect={(index) =>
            onSelect({
              path: `knowledge.forbiddenMetaKnowledge.${index}`,
              label: "元知识边界",
            })
          }
          onChange={(forbiddenMetaKnowledge) =>
            update({ ...spec.knowledge, forbiddenMetaKnowledge })
          }
        />
      </div>
    </section>
  );
}
