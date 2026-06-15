import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createLogger } from '../src/logger';
import { UploadQueue } from '../src/queue';
import { UploadWorker } from '../src/upload-worker';
import { UploadError } from '../src/uploader';

interface JobState {
  status: string;
  retry_count: number;
  last_error: string | null;
  next_attempt_at: string;
}

describe('UploadWorker', () => {
  let queue: UploadQueue | undefined;
  let worker: UploadWorker | undefined;
  let temporaryFolder: string;

  afterEach(async () => {
    await worker?.stop();
    queue?.close();
    worker = undefined;
    queue = undefined;

    if (temporaryFolder) {
      fs.rmSync(temporaryFolder, {
        recursive: true,
        force: true,
      });
    }
  });

  it('uploads and completes the next queued job', async () => {
    const setup = createSetup();
    const upload = vi.fn().mockResolvedValue(undefined);
    worker = new UploadWorker(queue!, { upload }, setup.uploadConfig);

    worker.start();

    await vi.waitFor(() => {
      expect(upload).toHaveBeenCalledOnce();
      expect(readJob(setup.databasePath).status).toBe('completed');
    });
  });

  it('reschedules a transient upload failure', async () => {
    const setup = createSetup();
    const upload = vi
      .fn()
      .mockRejectedValue(new UploadError('Server unavailable', true, 503));
    worker = new UploadWorker(queue!, { upload }, setup.uploadConfig);

    worker.start();

    await vi.waitFor(() => {
      expect(readJob(setup.databasePath)).toMatchObject({
        status: 'pending',
        retry_count: 1,
        last_error: 'Server unavailable',
      });
    });

    expect(
      new Date(readJob(setup.databasePath).next_attempt_at).getTime(),
    ).toBeGreaterThan(Date.now());
  });

  it('permanently fails a non-retryable upload', async () => {
    const setup = createSetup();
    const upload = vi
      .fn()
      .mockRejectedValue(new UploadError('Unauthorized', false, 401));
    worker = new UploadWorker(queue!, { upload }, setup.uploadConfig);

    worker.start();

    await vi.waitFor(() => {
      expect(readJob(setup.databasePath)).toMatchObject({
        status: 'failed',
        retry_count: 1,
        last_error: 'Unauthorized',
      });
    });
  });

  function createSetup(): {
    databasePath: string;
    uploadConfig: {
      request_timeout_ms: number;
      max_attempts: number;
      initial_retry_delay_ms: number;
      max_retry_delay_ms: number;
      worker_poll_interval_ms: number;
    };
  } {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'upload-worker-test-'),
    );
    const databasePath = path.join(temporaryFolder, 'agent.db');

    createLogger({
      agent: {
        id: 'test-agent',
        heartbeat_interval_seconds: 60,
        log_level: 'error',
      },
      watched_folders: [
        {
          path: temporaryFolder,
          label: 'Test',
          priority: 1,
        },
      ],
      validation: {
        max_file_size_mb: 100,
        allowed_extensions: ['.pdf'],
        rejected_folder: path.join(temporaryFolder, 'rejected'),
        stability_check_interval_ms: 100,
        stability_check_count: 2,
      },
      upload: {
        request_timeout_ms: 1_000,
        max_attempts: 5,
        initial_retry_delay_ms: 60_000,
        max_retry_delay_ms: 60_000,
        worker_poll_interval_ms: 10,
      },
      logging: {
        dir: temporaryFolder,
        max_files: '1d',
        max_size: '1m',
      },
    });

    queue = new UploadQueue(databasePath);
    queue.addJob(
      'report.pdf',
      path.join(temporaryFolder, 'report.pdf'),
      100,
    );

    return {
      databasePath,
      uploadConfig: {
        request_timeout_ms: 1_000,
        max_attempts: 5,
        initial_retry_delay_ms: 60_000,
        max_retry_delay_ms: 60_000,
        worker_poll_interval_ms: 10,
      },
    };
  }
});

function readJob(databasePath: string): JobState {
  const database = new Database(databasePath, { readonly: true });
  const job = database
    .prepare(`
      SELECT status, retry_count, last_error, next_attempt_at
      FROM upload_jobs
      WHERE id = 1
    `)
    .get() as JobState;
  database.close();
  return job;
}
