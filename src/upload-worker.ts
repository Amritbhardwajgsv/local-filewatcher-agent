import type { AgentConfig } from './config';
import { getLogger } from './logger';
import type { UploadJob, UploadQueue } from './queue';
import {
  calculateRetryDelay,
  type FileUploader,
  UploadError,
} from './uploader';

export class UploadWorker {
  private readonly queue: UploadQueue;
  private readonly uploader: Pick<FileUploader, 'upload'>;
  private readonly config: AgentConfig['upload'];
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private stopped = true;
  private wakeRequested = false;

  constructor(
    queue: UploadQueue,
    uploader: Pick<FileUploader, 'upload'>,
    config: AgentConfig['upload'],
  ) {
    this.queue = queue;
    this.uploader = uploader;
    this.config = config;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    const recoveredJobs = this.queue.recoverInterruptedJobs();

    if (recoveredJobs > 0) {
      getLogger().warn('Recovered interrupted upload jobs', {
        event: 'uploads_recovered',
        count: recoveredJobs,
      });
    }

    this.wake();
  }

  wake(): void {
    if (this.stopped) {
      return;
    }

    if (this.activeRun) {
      this.wakeRequested = true;
      return;
    }

    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeRequested = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.activeRun;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, delayMs);
  }

  private run(): void {
    if (this.stopped || this.activeRun) {
      return;
    }

    this.activeRun = this.processNextJob().finally(() => {
      this.activeRun = null;

      if (this.stopped) {
        return;
      }

      const delayMs = this.wakeRequested
        ? 0
        : this.config.worker_poll_interval_ms;
      this.wakeRequested = false;
      this.schedule(delayMs);
    });
  }

  private async processNextJob(): Promise<void> {
    const job = this.queue.claimNextPendingJob();

    if (!job) {
      return;
    }

    const logger = getLogger();
    const attempt = job.retryCount + 1;

    logger.info('Uploading file', {
      event: 'upload_started',
      job_id: job.id,
      file: job.filename,
      attempt,
    });

    try {
      await this.uploader.upload(job);
      this.queue.markCompleted(job.id);

      logger.info('File upload completed', {
        event: 'upload_completed',
        job_id: job.id,
        file: job.filename,
        attempt,
      });
    } catch (error) {
      this.handleFailure(job, error, attempt);
    }
  }

  private handleFailure(
    job: UploadJob,
    error: unknown,
    attempt: number,
  ): void {
    const logger = getLogger();
    const uploadError =
      error instanceof UploadError
        ? error
        : new UploadError(getErrorMessage(error), true);
    const canRetry =
      uploadError.retryable &&
      attempt < this.config.max_attempts;

    if (canRetry) {
      const delayMs = calculateRetryDelay(
        job.retryCount,
        this.config.initial_retry_delay_ms,
        this.config.max_retry_delay_ms,
      );
      const nextAttemptAt = new Date(Date.now() + delayMs);
      this.queue.scheduleRetry(
        job.id,
        uploadError.message,
        nextAttemptAt,
      );

      logger.warn('File upload scheduled for retry', {
        event: 'upload_retry_scheduled',
        job_id: job.id,
        file: job.filename,
        attempt,
        delay_ms: delayMs,
        next_attempt_at: nextAttemptAt.toISOString(),
        error: uploadError.message,
      });
      return;
    }

    this.queue.markFailed(job.id, uploadError.message);

    logger.error('File upload permanently failed', {
      event: 'upload_failed',
      job_id: job.id,
      file: job.filename,
      attempt,
      retryable: uploadError.retryable,
      status_code: uploadError.statusCode,
      error: uploadError.message,
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
