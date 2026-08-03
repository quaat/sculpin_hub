import type { Logger } from "pino";
import type { Database } from "@sculpin/db";
import type { JobRunner } from "@sculpin/jobs";
export class WorkerRuntime {
  readonly #controller = new AbortController();
  #stopped = false;
  constructor(
    private readonly database: Database,
    private readonly runner: JobRunner,
    private readonly logger: Logger,
  ) {}
  async start(): Promise<void> {
    if (!(await this.database.ready()))
      throw new Error("Worker database readiness check failed.");
    if (this.runner.handlerCount === 0) {
      this.logger.info("no production job handlers registered; worker is idle");
      return;
    }
    await this.runner.runOnce(this.#controller.signal);
  }
  async stop(signal: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.logger.info({ signal }, "worker shutdown started");
    this.#controller.abort();
    await this.database.close();
    this.logger.info("worker shutdown completed");
  }
}
