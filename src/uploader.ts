import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentConfig, AgentSecrets } from './config';
import type {
  UploadedPart,
  UploadJob,
  UploadQueue,
} from './queue';

interface InitiateUploadResponse {
  sessionId: string;
  chunkSize: number;
  totalParts: number;
}

interface PartUrlResponse {
  uploadUrl: string;
}

export class UploadError extends Error {
  readonly retryable: boolean;
  readonly blocked: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    retryable: boolean,
    statusCode?: number,
    blocked = false,
  ) {
    super(message);
    this.name = 'UploadError';
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.blocked = blocked;
  }
}

export class FileUploader {
  private readonly apiBaseUrl: string;
  private readonly secrets: AgentSecrets;
  private readonly timeoutMs: number;
  private readonly queue: UploadQueue;

  constructor(
    config: AgentConfig,
    secrets: AgentSecrets,
    queue: UploadQueue,
  ) {
    this.apiBaseUrl = secrets.cloudApiUrl.replace(/\/+$/, '');
    this.secrets = secrets;
    this.timeoutMs = config.upload.request_timeout_ms;
    this.queue = queue;
  }

  async upload(job: UploadJob): Promise<void> {
    await this.validateSourceFile(job);

    const session = job.uploadSessionId
      ? this.readPersistedSession(job)
      : await this.initiateUpload(job);
    const uploadedParts = new Map(
      job.uploadedParts.map((part) => [part.partNumber, part]),
    );
    const file = await fs.promises.open(job.filePath, 'r');

    try {
      for (
        let partNumber = 1;
        partNumber <= session.totalParts;
        partNumber += 1
      ) {
        if (uploadedParts.has(partNumber)) {
          continue;
        }

        const part = await this.uploadPart(
          job,
          session.sessionId,
          session.chunkSize,
          partNumber,
          file,
        );
        uploadedParts.set(partNumber, part);

        if (!this.queue.saveUploadedPart(job.id, part)) {
          throw new UploadError(
            `Could not persist uploaded part ${partNumber}`,
            true,
          );
        }
      }
    } finally {
      await file.close();
    }

    const parts = [...uploadedParts.values()].sort(
      (left, right) => left.partNumber - right.partNumber,
    );

    if (parts.length !== session.totalParts) {
      throw new UploadError(
        `Upload has ${parts.length} of ${session.totalParts} required parts`,
        true,
      );
    }

    await this.apiPost(
      `/uploads/${encodeURIComponent(session.sessionId)}/complete`,
      { parts },
    );
  }

  async abort(job: UploadJob): Promise<void> {
    const currentJob = this.queue.getJob(job.id);
    const sessionId = currentJob?.uploadSessionId;

    if (!sessionId) {
      return;
    }

    await this.apiPost(
      `/uploads/${encodeURIComponent(sessionId)}/abort`,
    );
    this.queue.clearUploadSession(job.id);
  }

  private async initiateUpload(
    job: UploadJob,
  ): Promise<InitiateUploadResponse> {
    const response = await this.apiPost<InitiateUploadResponse>(
      '/uploads/initiate',
      {
        filename: job.filename,
        sizeBytes: job.sizeBytes,
        agentId: this.secrets.agentId,
        contentType: getContentType(job.filename),
      },
      {
        'Idempotency-Key': `${this.secrets.agentId}-${job.id}`,
      },
    );
    const session = validateInitiateResponse(response.data);

    if (
      !this.queue.saveUploadSession(
        job.id,
        session.sessionId,
        session.chunkSize,
        session.totalParts,
      )
    ) {
      throw new UploadError('Could not persist upload session', true);
    }

    return session;
  }

  private readPersistedSession(
    job: UploadJob,
  ): InitiateUploadResponse {
    if (
      !job.uploadSessionId ||
      !job.chunkSize ||
      !job.totalParts
    ) {
      throw new UploadError(
        'Persisted upload session is incomplete',
        false,
      );
    }

    return {
      sessionId: job.uploadSessionId,
      chunkSize: job.chunkSize,
      totalParts: job.totalParts,
    };
  }

  private async uploadPart(
    job: UploadJob,
    sessionId: string,
    chunkSize: number,
    partNumber: number,
    file: fs.promises.FileHandle,
  ): Promise<UploadedPart> {
    const partUrlResponse = await this.apiPost<PartUrlResponse>(
      `/uploads/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
    );
    const uploadUrl = validatePartUrlResponse(partUrlResponse.data);
    const start = (partNumber - 1) * chunkSize;
    const length = Math.min(chunkSize, job.sizeBytes - start);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(chunk, 0, length, start);

    if (bytesRead !== length) {
      throw new UploadError(
        `Could not read complete chunk ${partNumber}`,
        false,
      );
    }

    try {
      const response = await axios.put(uploadUrl, chunk, {
        headers: {
          'Content-Length': String(length),
        },
        timeout: this.timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      const etag = response.headers.etag;

      if (typeof etag !== 'string' || etag.length === 0) {
        throw new UploadError(
          `S3 did not return an ETag for part ${partNumber}`,
          true,
        );
      }

      return { partNumber, etag };
    } catch (error) {
      throw classifyUploadError(error, true);
    }
  }

  private async validateSourceFile(job: UploadJob): Promise<void> {
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
  }

  private async apiPost<T = unknown>(
    route: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    try {
      return await axios.post<T>(
        `${this.apiBaseUrl}${route}`,
        body,
        {
          headers: {
            Authorization: `Bearer ${this.secrets.cloudApiKey}`,
            ...extraHeaders,
          },
          timeout: this.timeoutMs,
        },
      );
    } catch (error) {
      throw classifyUploadError(error, false);
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

function validateInitiateResponse(
  value: InitiateUploadResponse,
): InitiateUploadResponse {
  if (
    !value ||
    typeof value.sessionId !== 'string' ||
    !Number.isInteger(value.chunkSize) ||
    value.chunkSize <= 0 ||
    !Number.isInteger(value.totalParts) ||
    value.totalParts <= 0
  ) {
    throw new UploadError(
      'Upload API returned an invalid initiate response',
      false,
    );
  }

  return value;
}

function validatePartUrlResponse(value: PartUrlResponse): string {
  if (
    !value ||
    typeof value.uploadUrl !== 'string' ||
    !/^https?:\/\//.test(value.uploadUrl)
  ) {
    throw new UploadError(
      'Upload API returned an invalid presigned URL',
      false,
    );
  }

  return value.uploadUrl;
}

function classifyUploadError(
  error: unknown,
  storageRequest: boolean,
): UploadError {
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
    statusCode >= 500 ||
    (storageRequest && (statusCode === 400 || statusCode === 403));
  const blocked =
    !storageRequest &&
    (statusCode === 401 || statusCode === 403);
  const responseMessage = getResponseErrorMessage(error.response?.data);

  return new UploadError(
    responseMessage
      ? `Upload request failed with HTTP ${statusCode}: ${responseMessage}`
      : `Upload request failed with HTTP ${statusCode}`,
    retryable,
    statusCode,
    blocked,
  );
}

function getResponseErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 500) : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of ['error', 'message', 'detail']) {
    if (typeof record[key] === 'string' && record[key].trim()) {
      return record[key].trim().slice(0, 500);
    }
  }

  return undefined;
}

function getContentType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.doc':
      return 'application/msword';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
