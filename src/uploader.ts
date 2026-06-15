import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';

import type { AgentConfig, AgentSecrets } from './config';
import type { UploadJob } from './queue';

export class UploadError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    retryable: boolean,
    statusCode?: number,
  ) {
    super(message);
    this.name = 'UploadError';
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export class FileUploader {
  private readonly uploadUrl: string;
  private readonly secrets: AgentSecrets;
  private readonly timeoutMs: number;

  constructor(config: AgentConfig, secrets: AgentSecrets) {
    this.uploadUrl = `${secrets.cloudApiUrl.replace(/\/+$/, '')}/uploads`;
    this.secrets = secrets;
    this.timeoutMs = config.upload.request_timeout_ms;
  }

  async upload(job: UploadJob): Promise<void> {
    let stats: fs.Stats;

    try {
      stats = await fs.promises.stat(job.filePath);
    } catch (error) {
      throw new UploadError(
        `Source file is unavailable: ${getErrorMessage(error)}`,
        false,
      );
    }

    if (!stats.isFile()) {
      throw new UploadError('Source path is not a file', false);
    }

    if (stats.size !== job.sizeBytes) {
      throw new UploadError(
        `Source file size changed from ${job.sizeBytes} to ${stats.size} bytes`,
        false,
      );
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(job.filePath), {
      filename: job.filename,
      knownLength: job.sizeBytes,
    });
    form.append('agent_id', this.secrets.agentId);
    form.append('filename', job.filename);
    form.append('size_bytes', String(job.sizeBytes));
    form.append('detected_at', job.detectedAt);

    try {
      await axios.post(this.uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${this.secrets.cloudApiKey}`,
          'Idempotency-Key': `${this.secrets.agentId}-${job.id}`,
        },
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (error) {
      throw classifyUploadError(error);
    }
  }
}

export function calculateRetryDelay(
  retryCount: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random = Math.random,
): number {
  const exponentialDelay = Math.min(
    initialDelayMs * 2 ** retryCount,
    maxDelayMs,
  );
  const jitterMultiplier = 0.5 + random() * 0.5;

  return Math.round(exponentialDelay * jitterMultiplier);
}

function classifyUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) {
    return error;
  }

  if (!axios.isAxiosError(error)) {
    return new UploadError(getErrorMessage(error), true);
  }

  const statusCode = error.response?.status;

  if (statusCode === undefined) {
    return new UploadError(
      `Upload request failed: ${error.message}`,
      true,
    );
  }

  const retryable =
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode >= 500;

  return new UploadError(
    `Upload request failed with HTTP ${statusCode}`,
    retryable,
    statusCode,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
