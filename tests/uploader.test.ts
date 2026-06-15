import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import type { AgentConfig, AgentSecrets } from '../src/config';
import { UploadQueue } from '../src/queue';
import {
  calculateRetryDelay,
  FileUploader,
  UploadError,
} from '../src/uploader';

let temporaryFolder: string;
let queue: UploadQueue | undefined;

describe('FileUploader', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    queue?.close();
    queue = undefined;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      server = undefined;
    }

    if (temporaryFolder) {
      fs.rmSync(temporaryFolder, {
        recursive: true,
        force: true,
      });
    }
  });

  it('uploads file chunks directly and completes with their ETags', async () => {
    createQueuedFile('abcdefghijkl');
    const uploadedChunks = new Map<number, string>();
    let initiateBody: Record<string, unknown> | undefined;
    let completeBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    let idempotencyKey: string | undefined;
    const listener = await listen(async (request, response, baseUrl) => {
      authorization = request.headers.authorization;

      if (
        request.method === 'POST' &&
        request.url === '/api/v1/uploads/initiate'
      ) {
        idempotencyKey = request.headers['idempotency-key'] as string;
        initiateBody = JSON.parse(await readBody(request));
        sendJson(response, 200, {
          sessionId: 'session-123',
          chunkSize: 5,
          totalParts: 3,
        });
        return;
      }

      const partMatch = request.url?.match(
        /^\/api\/v1\/uploads\/session-123\/parts\/(\d+)$/,
      );

      if (request.method === 'POST' && partMatch) {
        const partNumber = Number(partMatch[1]);
        sendJson(response, 200, {
          uploadUrl: `${baseUrl}/s3/${partNumber}`,
        });
        return;
      }

      const putMatch = request.url?.match(/^\/s3\/(\d+)$/);

      if (request.method === 'PUT' && putMatch) {
        const partNumber = Number(putMatch[1]);
        uploadedChunks.set(partNumber, await readBody(request));
        response.writeHead(200, {
          ETag: `"etag-${partNumber}"`,
        });
        response.end();
        return;
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/v1/uploads/session-123/complete'
      ) {
        completeBody = JSON.parse(await readBody(request));
        sendJson(response, 200, { status: 'completed' });
        return;
      }

      response.writeHead(404);
      response.end();
    });
    server = listener.server;

    const uploader = new FileUploader(
      createConfig(),
      createSecrets(`${listener.baseUrl}/api/v1`),
      queue!,
    );
    await uploader.upload(queue!.getJob(1)!);

    expect(authorization).toBe('Bearer secret-key');
    expect(idempotencyKey).toBe('agent-01-1');
    expect(initiateBody).toEqual({
      filename: 'report.pdf',
      sizeBytes: 12,
      agentId: 'agent-01',
      contentType: 'application/pdf',
    });
    expect([...uploadedChunks.entries()]).toEqual([
      [1, 'abcde'],
      [2, 'fghij'],
      [3, 'kl'],
    ]);
    expect(completeBody).toEqual({
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
    expect(queue!.getJob(1)).toMatchObject({
      uploadSessionId: 'session-123',
      chunkSize: 5,
      totalParts: 3,
      uploadedParts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
  });

  it('resumes a persisted session without uploading completed parts again', async () => {
    createQueuedFile('abcdefghij');
    queue!.saveUploadSession(1, 'session-resume', 5, 2);
    queue!.saveUploadedPart(1, {
      partNumber: 1,
      etag: '"existing-etag"',
    });
    const uploadedPartNumbers: number[] = [];
    let completedParts: unknown;
    const listener = await listen(async (request, response, baseUrl) => {
      const partMatch = request.url?.match(
        /^\/api\/v1\/uploads\/session-resume\/parts\/(\d+)$/,
      );

      if (request.method === 'POST' && partMatch) {
        const partNumber = Number(partMatch[1]);
        sendJson(response, 200, {
          uploadUrl: `${baseUrl}/s3/${partNumber}`,
        });
        return;
      }

      const putMatch = request.url?.match(/^\/s3\/(\d+)$/);

      if (request.method === 'PUT' && putMatch) {
        const partNumber = Number(putMatch[1]);
        uploadedPartNumbers.push(partNumber);
        await readBody(request);
        response.writeHead(200, { ETag: `"etag-${partNumber}"` });
        response.end();
        return;
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/v1/uploads/session-resume/complete'
      ) {
        completedParts = JSON.parse(await readBody(request)).parts;
        sendJson(response, 200, { status: 'completed' });
        return;
      }

      response.writeHead(404);
      response.end();
    });
    server = listener.server;

    const uploader = new FileUploader(
      createConfig(),
      createSecrets(`${listener.baseUrl}/api/v1`),
      queue!,
    );
    await uploader.upload(queue!.getJob(1)!);

    expect(uploadedPartNumbers).toEqual([2]);
    expect(completedParts).toEqual([
      { partNumber: 1, etag: '"existing-etag"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);
  });

  it('treats a missing source file as permanent failure', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'uploader-test-'),
    );
    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', path.join(temporaryFolder, 'missing.pdf'), 12);
    queue.markUploading(1);
    const uploader = new FileUploader(
      createConfig(),
      createSecrets('http://127.0.0.1:1/api/v1'),
      queue,
    );

    await expect(uploader.upload(queue.getJob(1)!)).rejects.toMatchObject({
      name: 'UploadError',
      retryable: false,
    });
  });

  it('treats an expired S3 part URL as retryable', async () => {
    createQueuedFile('abcde');
    const listener = await listen(async (request, response, baseUrl) => {
      if (request.url === '/api/v1/uploads/initiate') {
        await readBody(request);
        sendJson(response, 200, {
          sessionId: 'session-expired',
          chunkSize: 5,
          totalParts: 1,
        });
        return;
      }

      if (request.url?.includes('/parts/1')) {
        sendJson(response, 200, {
          uploadUrl: `${baseUrl}/expired`,
        });
        return;
      }

      if (request.url === '/expired') {
        await readBody(request);
        response.writeHead(403);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    });
    server = listener.server;
    const uploader = new FileUploader(
      createConfig(),
      createSecrets(`${listener.baseUrl}/api/v1`),
      queue!,
    );

    await expect(uploader.upload(queue!.getJob(1)!)).rejects.toEqual(
      expect.objectContaining<Partial<UploadError>>({
        retryable: true,
        statusCode: 403,
      }),
    );
  });

  it('classifies a backend authorization failure as blocked', async () => {
    createQueuedFile('abcde');
    const listener = await listen(async (request, response) => {
      await readBody(request);
      sendJson(response, 403, {
        error: 'Agent is not authorized',
      });
    });
    server = listener.server;
    const uploader = new FileUploader(
      createConfig(),
      createSecrets(`${listener.baseUrl}/api/v1`),
      queue!,
    );

    await expect(uploader.upload(queue!.getJob(1)!)).rejects.toEqual(
      expect.objectContaining<Partial<UploadError>>({
        blocked: true,
        retryable: false,
        statusCode: 403,
        message:
          'Upload request failed with HTTP 403: Agent is not authorized',
      }),
    );
  });
});

describe('calculateRetryDelay', () => {
  it('applies exponential backoff, jitter, and a maximum delay', () => {
    expect(calculateRetryDelay(0, 5_000, 300_000, () => 1)).toBe(5_000);
    expect(calculateRetryDelay(1, 5_000, 300_000, () => 1)).toBe(10_000);
    expect(calculateRetryDelay(10, 5_000, 300_000, () => 1)).toBe(300_000);
    expect(calculateRetryDelay(0, 5_000, 300_000, () => 0)).toBe(2_500);
  });
});

function createQueuedFile(content: string): { filePath: string } {
  temporaryFolder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'uploader-test-'),
  );
  const filePath = path.join(temporaryFolder, 'report.pdf');
  fs.writeFileSync(filePath, content);
  queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
  queue.addJob('report.pdf', filePath, Buffer.byteLength(content));
  queue.markUploading(1);
  return { filePath };
}

function createConfig(): AgentConfig {
  return {
    agent: {
      id: 'agent-01',
      heartbeat_interval_seconds: 60,
      log_level: 'error',
    },
    watched_folders: [
      {
        path: './watched',
        label: 'Documents',
        priority: 1,
      },
    ],
    validation: {
      max_file_size_mb: 100,
      allowed_extensions: ['.pdf'],
      rejected_folder: './rejected',
      stability_check_interval_ms: 100,
      stability_check_count: 2,
    },
    upload: {
      request_timeout_ms: 5_000,
      max_attempts: 5,
      initial_retry_delay_ms: 5_000,
      max_retry_delay_ms: 300_000,
      blocked_retry_delay_ms: 300_000,
      worker_poll_interval_ms: 1_000,
    },
    logging: {
      dir: './logs',
      max_files: '1d',
      max_size: '1m',
    },
  };
}

function createSecrets(cloudApiUrl: string): AgentSecrets {
  return {
    cloudApiUrl,
    cloudApiKey: 'secret-key',
    agentId: 'agent-01',
  };
}

async function listen(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    baseUrl: string,
  ) => Promise<void>,
): Promise<{ server: http.Server; baseUrl: string }> {
  let baseUrl = '';
  const server = http.createServer((request, response) => {
    void handler(request, response, baseUrl);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(value));
}
