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
import type { UploadJob } from '../src/queue';
import {
  calculateRetryDelay,
  FileUploader,
  UploadError,
} from '../src/uploader';

let server: http.Server | undefined;

describe('FileUploader', () => {
  let temporaryFolder: string;

  afterEach(async () => {
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

  it('streams a multipart upload with authentication and metadata', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'uploader-test-'),
    );
    const filePath = path.join(temporaryFolder, 'report.pdf');
    fs.writeFileSync(filePath, 'PDF content');

    const request = await listen((incoming, response) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        body += chunk;
      });
      incoming.on('end', () => {
        response.writeHead(201);
        response.end();
      });

      return () => body;
    });

    const uploader = new FileUploader(
      createConfig(),
      createSecrets(request.baseUrl),
    );
    await uploader.upload(createJob(filePath));

    expect(request.method()).toBe('POST');
    expect(request.url()).toBe('/api/v1/uploads');
    expect(request.headers().authorization).toBe('Bearer secret-key');
    expect(request.headers()['idempotency-key']).toBe('agent-01-7');
    expect(request.headers()['content-type']).toContain(
      'multipart/form-data; boundary=',
    );
    expect(request.body()).toContain('name="agent_id"');
    expect(request.body()).toContain('agent-01');
    expect(request.body()).toContain('name="filename"');
    expect(request.body()).toContain('report.pdf');
    expect(request.body()).toContain('PDF content');
  });

  it('treats a missing source file as permanent failure', async () => {
    const uploader = new FileUploader(
      createConfig(),
      createSecrets('http://127.0.0.1:1/api/v1'),
    );

    await expect(
      uploader.upload(createJob('C:\\missing\\report.pdf')),
    ).rejects.toMatchObject({
      name: 'UploadError',
      retryable: false,
    });
  });

  it('classifies server failures as retryable', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'uploader-test-'),
    );
    const filePath = path.join(temporaryFolder, 'report.pdf');
    fs.writeFileSync(filePath, 'PDF content');

    const request = await listen((_incoming, response) => {
      response.writeHead(503);
      response.end();
      return () => '';
    });
    const uploader = new FileUploader(
      createConfig(),
      createSecrets(request.baseUrl),
    );

    await expect(uploader.upload(createJob(filePath))).rejects.toEqual(
      expect.objectContaining<Partial<UploadError>>({
        retryable: true,
        statusCode: 503,
      }),
    );
  });

  it('classifies ordinary client failures as permanent', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'uploader-test-'),
    );
    const filePath = path.join(temporaryFolder, 'report.pdf');
    fs.writeFileSync(filePath, 'PDF content');

    const request = await listen((_incoming, response) => {
      response.writeHead(422);
      response.end();
      return () => '';
    });
    const uploader = new FileUploader(
      createConfig(),
      createSecrets(request.baseUrl),
    );

    await expect(uploader.upload(createJob(filePath))).rejects.toEqual(
      expect.objectContaining<Partial<UploadError>>({
        retryable: false,
        statusCode: 422,
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

function createJob(filePath: string): UploadJob {
  return {
    id: 7,
    filename: 'report.pdf',
    filePath,
    sizeBytes: 11,
    status: 'uploading',
    retryCount: 0,
    lastError: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    detectedAt: '2026-06-15T00:00:00.000Z',
    nextAttemptAt: '2026-06-15T00:00:00.000Z',
    completedAt: null,
  };
}

async function listen(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => () => string,
): Promise<{
  baseUrl: string;
  method: () => string | undefined;
  url: () => string | undefined;
  headers: () => http.IncomingHttpHeaders;
  body: () => string;
}> {
  let method: string | undefined;
  let url: string | undefined;
  let headers: http.IncomingHttpHeaders = {};
  let getBody = () => '';

  server = http.createServer((request, response) => {
    method = request.method;
    url = request.url;
    headers = request.headers;
    getBody = handler(request, response);
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    method: () => method,
    url: () => url,
    headers: () => headers,
    body: () => getBody(),
  };
}
