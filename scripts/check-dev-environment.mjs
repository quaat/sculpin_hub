import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expected = [
  "DATABASE_URL",
  "PORT",
  "PROXY_PORT",
  "PROXY_HOST",
  "PROXY_BODY_LIMIT_BYTES",
  "PROXY_SHUTDOWN_TIMEOUT_MS",
  "WORKER_SHUTDOWN_TIMEOUT_MS",
];
for (const workspace of ["@sculpin/web", "@sculpin/proxy", "@sculpin/worker"]) {
  const script = JSON.parse(
    readFileSync(
      new URL(
        `../apps/${workspace.split("/")[1]}/package.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ).scripts.dev;
  if (!script.includes("--env-file=../../.env"))
    throw new Error(
      `${workspace} dev script does not load the root .env file.`,
    );
  const result = spawnSync(
    process.execPath,
    [
      "--env-file=../../.env",
      "-e",
      `const required=${JSON.stringify(expected)};for(const key of required){if(!process.env[key])throw new Error(key+" is missing")}`,
    ],
    {
      cwd: new URL(`../apps/${workspace.split("/")[1]}/`, import.meta.url),
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(
      `${workspace} failed root environment smoke validation: ${result.stderr.trim()}`,
    );
  process.stdout.write(
    `${workspace}: root environment loaded (values redacted)\n`,
  );
}
