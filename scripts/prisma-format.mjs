import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const schema = "packages/db/prisma/schema.prisma";
const check = process.argv.includes("--check");
if (!check) {
  await exec("pnpm", ["prisma", "format", "--schema", schema], {
    stdio: "inherit",
  });
} else {
  const before = await readFile(schema, "utf8");
  const dir = await mkdtemp(join(tmpdir(), "sculpin-prisma-format-"));
  const copy = join(dir, "schema.prisma");
  try {
    await copyFile(schema, copy);
    await exec("pnpm", ["prisma", "format", "--schema", copy]);
    const after = await readFile(copy, "utf8");
    if (before !== after) {
      console.error("Prisma schema is not formatted. Run pnpm prisma:format.");
      process.exitCode = 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
