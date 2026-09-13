import { extractHostedResearchImages } from "../apps/server/src/hosted/research-export.js";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: pnpm hosted:extract-research <research.jsonl> <new-empty-directory>",
  );
const result = await extractHostedResearchImages({ source, destination });
process.stdout.write(
  `已提取 ${result.fileCount} 张原图，保留 ${result.recordCount} 条研究关联。清单：${result.manifestPath}\n`,
);
