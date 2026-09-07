/** Finite, source-verifiable projections. No model confidence or error reason
 * grants authority; unsupported or ambiguous clauses remain ordinary reports. */
export interface ExplicitCurrentFactProjection {
  subjectKey: string;
  entity: string;
  attribute: "name" | "identifier" | "usual_drink";
  value: string;
  content: string;
  revisionIntent?: "explicit_correction" | "temporal_update";
  previousValue?: string;
}

export interface FactQueryNeed {
  subjectKey: string;
  entity: string;
  attribute: ExplicitCurrentFactProjection["attribute"];
}

const PERSON =
  "(?:(?:项目组|设计组|工作上的)?(?:同事|妹妹|姐姐|弟弟|哥哥|朋友|室友|妈妈|爸爸))";
const PROJECT = "(?:[A-Za-z][A-Za-z0-9_-]{0,15}项目|项目)";
const NAME = "[\\p{Script=Han}A-Za-z·]{1,20}";
const ID = "[A-Za-z0-9][A-Za-z0-9_-]{1,39}";
const PREFIX =
  /^(?:(?:更正|纠正|修正|更新)(?:一下|一个事实|另一件事)?|我(?:刚才|之前)?说错了)\s*[:：,，]?\s*/u;
const NON_ASSERTION =
  /[?？]|(?:是不是|是否|要不要|能不能|可能|也许|或许|不确定|假如|假设|如果|听说|据说|有人说|只是举例|不要记|别记|别据此)|^[^，,。:：]{1,16}(?:说|表示|声称)\s*[:：,，]/u;

export function extractExplicitCurrentFactProjections(
  text: string,
): ExplicitCurrentFactProjection[] {
  const normalized = text.normalize("NFKC").trim();
  if (
    /(?:不要|别).{0,12}(?:记住|记录|当成|当作).{0,12}(?:事实|记忆)|只是举例/u.test(
      normalized,
    )
  )
    return [];
  const unquoted = normalized.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu,
    " ",
  );
  const facts = new Map<string, ExplicitCurrentFactProjection>();
  const ambiguous = new Set<string>();
  const add = (fact: ExplicitCurrentFactProjection) => {
    const previous = facts.get(fact.subjectKey);
    if (
      previous !== undefined &&
      previous.value !== fact.value &&
      fact.revisionIntent === undefined
    )
      ambiguous.add(fact.subjectKey);
    if (fact.revisionIntent !== undefined) ambiguous.delete(fact.subjectKey);
    facts.set(fact.subjectKey, fact);
  };
  for (const raw of unquoted.match(/[^。！？!?；;\r\n]+[。！？!?；;]?/gu) ??
    []) {
    const statement = raw.trim().replace(/[。；;]+$/u, "");
    if (NON_ASSERTION.test(statement)) continue;
    if (
      /(?:只在|仅在|只对|仅对|这次|本次|这个话题|聊工作时|谈工作时)/u.test(
        statement,
      )
    )
      continue;
    const prefixed = PREFIX.test(statement);
    const parseable = statement
      .replace(PREFIX, "")
      .replace(/^(?:记住|请记住|记一下)[:：,，]?\s*/u, "");
    // Convert only a complete entity/attribute replacement, after validating
    // both values. A bare "不是" elsewhere never authorizes this slot.
    const replacement = parseable
      .replace(
        new RegExp(
          `((?:(?:我|用户)(?:的)?)?${PERSON}(?:的)?(?:姓名|名字)?)(?:不是|不)(?:叫|是)?(${NAME})[，,]?(?:而是|应该是)(?:叫)?(${NAME})(?=[，,]|$)`,
          "gu",
        ),
        "$1叫$3，不是$2",
      )
      .replace(
        new RegExp(
          `(${PROJECT}(?:的)?(?:编号|代号))(?:不是|并非)\\s*(${ID})[，,]?\\s*(?:而是|应该是)\\s*(${ID})(?=[，,]|$)`,
          "gu",
        ),
        "$1是$3，不是$2",
      );
    const namePattern = new RegExp(
      `(?:^|[，,])\\s*(?:(?:我|用户)(?:的)?)?(${PERSON})(?:的)?(?:姓名|名字)?(?:叫|是|为|[:：])\\s*(${NAME})(?=[，,]|$)`,
      "gu",
    );
    const projectPattern = new RegExp(
      `(?:^|[，,])\\s*(?:(?:我|用户)(?:的)?(?:那个)?)?(${PROJECT})(?:的)?(?:编号|代号)(?:是|为|叫|[:：])?\\s*(${ID})(?=[，,]|$)`,
      "gu",
    );
    for (const [pattern, attribute] of [
      [namePattern, "name"],
      [projectPattern, "identifier"],
    ] as const) {
      for (const match of replacement.matchAll(pattern)) {
        const entity = match[1]!;
        const value = match[2]!;
        if (/^(?:什么|谁|那个|这个|不|没|可能)/u.test(value)) continue;
        const tail = replacement.slice(match.index + match[0].length);
        const oldValue = tail.match(
          new RegExp(
            `^[，,]\\s*(?:而)?(?:不是|并非|不叫)\\s*(${attribute === "name" ? NAME : ID})(?=[，,]|$)`,
            "u",
          ),
        )?.[1];
        const localCorrection =
          (prefixed && match.index === 0) ||
          (oldValue !== undefined &&
            !/(?:说错|记错|叫|是|名字|姓名)|^(?:我|你|他|她|用户)/u.test(
              oldValue,
            ));
        add({
          ...factNeed(entity, attribute),
          value,
          content: `用户的${entity}${attribute === "name" ? "姓名" : "编号"}：${value}。`,
          ...(localCorrection
            ? { revisionIntent: "explicit_correction" as const }
            : {}),
        });
      }
    }
    const temporal =
      parseable.match(
        /^(?:(?:我|用户)(?:的)?)(?:以前|过去|之前)(?:常|通常)?喝(咖啡|茶|奶茶|水)[，,]\s*(?:(?:我|用户))?(?:现在|目前)(?:改为|改成|改喝|喝)(咖啡|茶|奶茶|水)(?:了)?$/u,
      ) ??
      parseable.match(
        /^(?:以前|过去|之前)(?:常|通常)?喝(咖啡|茶|奶茶|水)[，,]\s*(?:现在|目前)(?:改为|改成|改喝|喝)(咖啡|茶|奶茶|水)(?:了)?$/u,
      );
    const usual =
      parseable.match(
        /^(?:我|用户)(?:现在|目前|平时|通常|一般|日常)(?:常)?喝(咖啡|茶|奶茶|水)(?:了)?$/u,
      ) ?? parseable.match(/^用户日常饮品[:：](咖啡|茶|奶茶|水)$/u);
    const drink = temporal?.[2] ?? usual?.[1];
    if (drink !== undefined)
      add({
        ...factNeed("用户", "usual_drink"),
        value: drink,
        content: `用户日常饮品：${drink}。`,
        ...(temporal === null
          ? {}
          : {
              revisionIntent: "temporal_update" as const,
              previousValue: temporal[1]!,
            }),
      });
  }
  return [...facts.values()].filter((fact) => !ambiguous.has(fact.subjectKey));
}

export function deriveFactQueryNeeds(text: string): FactQueryNeed[] {
  const query = text.normalize("NFKC").trim();
  if (
    !/(?:什么|叫什么|哪[个一]|多少|谁|分别|核对|告诉我|记错|说错|以前错|之前错|记得|回忆|[?？])/u.test(
      query,
    )
  )
    return [];
  if (/^(?:如果|假如|听说|据说)|[“”「」]/u.test(query)) return [];
  const needs = new Map<string, FactQueryNeed>();
  const add = (entity: string, attribute: FactQueryNeed["attribute"]) => {
    const need = factNeed(entity, attribute);
    needs.set(need.subjectKey, need);
  };
  const boundary =
    "(?:^|[，,。；;、]|(?:和|与|以及))\\s*(?:(?:请|麻烦)?(?:告诉我|帮我核对|帮我回忆|核对|回忆|说说)\\s*)?(?:现在|目前|当前)?(?:(?:我|用户)(?:的)?(?:那个)?)?";
  for (const match of query.matchAll(
    new RegExp(
      `${boundary}(${PERSON})(?:的)?(?:姓名|名字|叫(?:什么|啥)|叫什么名字)`,
      "gu",
    ),
  )) {
    add(match[1]!, "name");
  }
  for (const group of query.matchAll(
    new RegExp(
      `${boundary}((?:${PERSON}(?:和|与|、)){1,7}${PERSON})(?:的)?(?:姓名|名字|都?叫(?:什么|啥))`,
      "gu",
    ),
  )) {
    for (const person of group[1]!.matchAll(new RegExp(PERSON, "gu")))
      add(person[0], "name");
  }
  for (const match of query.matchAll(
    new RegExp(`${boundary}(${PROJECT})(?:的)?(?:编号|代号)`, "gu"),
  ))
    add(match[1]!, "identifier");
  if (
    /(?:我|用户).{0,8}(?:喝什么|喝的是|饮品|饮料)|(?:以前|现在).{0,6}(?:喝什么|喝的是)/u.test(
      query,
    )
  )
    add("用户", "usual_drink");
  return [...needs.values()].slice(0, 8);
}

export function isFactHistoryQuery(text: string): boolean {
  if (
    /(?:现在|当前|目前).{0,16}(?:什么|多少|谁|哪[个一])/u.test(text) &&
    !/(?:分别|对比|比较)/u.test(text)
  )
    return false;
  return /(?:以前|过去|之前|最初|原先).{0,10}(?:叫|姓名|名字|编号|代号|喝|错)|(?:改过|更正过|纠正过|错在哪|哪里错|历史|旧值|版本|变化)/u.test(
    text,
  );
}

function factNeed(
  entity: string,
  attribute: FactQueryNeed["attribute"],
): FactQueryNeed {
  if (attribute !== "usual_drink")
    entity = entity.replace(/^(?:我|用户)(?:的)?(?:那个)?/u, "");
  return {
    entity,
    attribute,
    subjectKey:
      attribute === "usual_drink"
        ? "user_preference:drink:usual"
        : `user_fact:current:${entity.toLocaleLowerCase()}:${attribute}`,
  };
}
