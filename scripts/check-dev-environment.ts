import {
  parseProxyConfig,
  parseWebConfig,
  parseWorkerConfig,
} from "../packages/config/src/index.ts";
const checks = [
  ["@sculpin/web", () => parseWebConfig(process.env)],
  ["@sculpin/proxy", () => parseProxyConfig(process.env)],
  ["@sculpin/worker", () => parseWorkerConfig(process.env)],
] as const;
for (const [workspace, parse] of checks) {
  parse();
  process.stdout.write(
    `${workspace}: runtime configuration parsed (values redacted)\n`,
  );
}
