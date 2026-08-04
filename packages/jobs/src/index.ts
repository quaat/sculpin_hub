export type JobId = string;
export type JobType = string;
export type JobPayload = Readonly<Record<string, unknown>>;
export interface AttemptMetadata {
  attempt: number;
  maxAttempts: number;
  claimedAt: Date;
  claimedBy: string;
}
export interface ClaimedJob<TPayload extends JobPayload = JobPayload> {
  id: JobId;
  type: JobType;
  payload: TPayload;
  attempt: AttemptMetadata;
}
export type JobResult =
  | { outcome: "completed" }
  | { outcome: "retryable_failure"; retryAt: Date; reasonCode: string }
  | { outcome: "terminal_failure"; reasonCode: string };
export interface JobHandler<TPayload extends JobPayload = JobPayload> {
  readonly type: JobType;
  handle(job: ClaimedJob<TPayload>, signal: AbortSignal): Promise<JobResult>;
}
export interface JobStore {
  claim(
    batchSize: number,
    workerId: string,
    now: Date,
  ): Promise<readonly ClaimedJob[]>;
  complete(jobId: JobId, workerId: string, result: JobResult): Promise<void>;
}
export interface JobRunner {
  readonly handlerCount: number;
  runOnce(signal: AbortSignal): Promise<number>;
}
export function createIdleJobRunner(): JobRunner {
  return {
    handlerCount: 0,
    runOnce() {
      return Promise.resolve(0);
    },
  };
}
