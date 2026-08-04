export interface ShutdownLogger {
  info(data: object, message: string): void;
  error(data: object, message: string): void;
  fatal(data: object, message: string): void;
}
export interface ShutdownOptions {
  shutdown(): Promise<void>;
  timeoutMs: number;
  logger: ShutdownLogger;
  exit(code: number): void;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}
export function createShutdownController(options: ShutdownOptions) {
  let operation: Promise<void> | undefined;
  return (signal: string): Promise<void> => {
    operation ??= (async () => {
      options.logger.info({ signal }, "graceful shutdown started");
      const timer = options.setTimer(() => {
        options.logger.fatal({ signal }, "graceful shutdown timed out");
        options.exit(1);
      }, options.timeoutMs);
      timer.unref?.();
      try {
        await options.shutdown();
        options.clearTimer(timer);
      } catch (error) {
        options.clearTimer(timer);
        options.logger.error(
          { err: error, signal },
          "graceful shutdown failed",
        );
        options.exit(1);
      }
    })();
    return operation;
  };
}
