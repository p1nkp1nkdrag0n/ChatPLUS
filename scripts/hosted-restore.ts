import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { restoreHostedBackup } from "../apps/server/src/hosted/backup.js";

const [source, keysSource, destination] = process.argv.slice(2);
if (!source || !keysSource || !destination)
  throw new Error(
    "Usage: pnpm hosted:restore <backup.dvbackup> <matching-backup.dvkeys> <new-empty-directory>",
  );
let passphrase = process.env.DEARVALE_BACKUP_PASSPHRASE;
if (!passphrase) {
  if (!process.stdin.isTTY)
    throw new Error(
      "Set DEARVALE_BACKUP_PASSPHRASE for non-interactive restoration.",
    );
  process.stdout.write("请输入备份密码（不会回显）：");
  const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: silentOutput,
    terminal: true,
  });
  try {
    passphrase = await prompt.question("");
  } finally {
    prompt.close();
    process.stdout.write("\n");
  }
}
const result = await restoreHostedBackup({
  source: resolve(source),
  keysSource: resolve(keysSource),
  destination: resolve(destination),
  passphrase,
});
process.stdout.write(`已恢复 ${result.fileCount} 个文件至 ${result.path}\n`);
