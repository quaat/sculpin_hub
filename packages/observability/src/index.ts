import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";
export const REDACTED = "[Redacted]";
export const redactionPaths = [
  "authorization",
  "cookie",
  "set-cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "*.authorization",
  "*.cookie",
  "*.set-cookie",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.api_key",
  "*.apiKey",
  "*.upstreamCredential",
  "*.upstream_credentials",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apiKey",
  "upstreamCredential",
  "upstream_credentials",
];
export interface LoggerContext {
  service: string;
  environment: string;
  level?: string;
  requestId?: string;
  traceId?: string;
}
export interface LoggerExtensions {
  serializers?: LoggerOptions["serializers"];
}
export function createLogger(
  context: LoggerContext,
  destination?: DestinationStream,
  extensions: LoggerExtensions = {},
): Logger {
  const options: LoggerOptions = {
    level: context.level ?? "info",
    base: { service: context.service, environment: context.environment },
    redact: { paths: redactionPaths, censor: REDACTED },
    serializers: {
      err: (error: unknown) => {
        if (typeof error !== "object" || error === null)
          return { type: "Error" };
        const value = error as { name?: unknown; code?: unknown };
        return {
          type: typeof value.name === "string" ? value.name : "Error",
          ...(typeof value.code === "string" ? { code: value.code } : {}),
        };
      },
      ...extensions.serializers,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
export function childLogger(
  logger: Logger,
  context: { requestId?: string; traceId?: string },
): Logger {
  return logger.child(context);
}
