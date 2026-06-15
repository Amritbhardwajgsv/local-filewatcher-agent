import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { UploadQueue } from '../src/queue';

interface UploadJobRow {
  filename: string;
  file_path: string;
  size_bytes: number;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  detected_at: string | null;
  next_attempt_at: string | null;
  completed_at: string | null;
}

describe('UploadQueue', () => {
  let queue: UploadQueue | undefined;
  let temporaryFolder: string;

  afterEach(() => {
    queue?.close();
    queue = undefined;

    if (temporaryFolder) {
      fs.rmSync(temporaryFolder, {
        recursive: true,
        force: true,
      });
    }
  });

  it('creates the SQLite database and upload_jobs table', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    const databasePath = path.join(temporaryFolder, 'agent.db');
    queue = new UploadQueue(databasePath);
    queue.close();
    queue = undefined;

    expect(fs.existsSync(databasePath)).toBe(true);

    const database = new Database(databasePath, { readonly: true });
    const table = database
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'upload_jobs'
      `)
      .get() as { name: string } | undefined;
    database.close();

    expect(table?.name).toBe('upload_jobs');
  });

  it('adds a pending upload job', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    const databasePath = path.join(temporaryFolder, 'agent.db');
    const filePath = path.join(temporaryFolder, 'report.pdf');

    queue = new UploadQueue(databasePath);
    queue.addJob('report.pdf', filePath, 2048);
    queue.close();
    queue = undefined;

    const database = new Database(databasePath, { readonly: true });
    const job = database
      .prepare(`
        SELECT
          filename,
          file_path,
          size_bytes,
          status,
          retry_count,
          last_error,
          created_at,
          detected_at,
          next_attempt_at,
          completed_at
        FROM upload_jobs
      `)
      .get() as UploadJobRow;
    database.close();

    expect(job).toMatchObject({
      filename: 'report.pdf',
      file_path: filePath,
      size_bytes: 2048,
      status: 'pending',
      retry_count: 0,
      last_error: null,
      completed_at: null,
    });
    expect(new Date(job.created_at).toString()).not.toBe('Invalid Date');
    expect(new Date(job.detected_at ?? '').toString()).not.toBe('Invalid Date');
    expect(new Date(job.next_attempt_at ?? '').toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('returns the oldest pending upload job', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('first.pdf', 'C:\\files\\first.pdf', 100);
    queue.addJob('second.pdf', 'C:\\files\\second.pdf', 200);

    expect(queue.getNextPendingJob()).toMatchObject({
      id: 1,
      filename: 'first.pdf',
      filePath: 'C:\\files\\first.pdf',
      sizeBytes: 100,
      status: 'pending',
      retryCount: 0,
      lastError: null,
    });
  });

  it('returns undefined when no pending job exists', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));

    expect(queue.getNextPendingJob()).toBeUndefined();
  });

  it('moves a job through uploading and completed statuses', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);

    expect(queue.markUploading(1)).toBe(true);
    expect(queue.getNextPendingJob()).toBeUndefined();
    expect(queue.markCompleted(1)).toBe(true);
    expect(queue.markCompleted(1)).toBe(false);
  });

  it('claims the next due job and marks it uploading atomically', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);

    expect(queue.claimNextPendingJob()).toMatchObject({
      id: 1,
      status: 'uploading',
    });
    expect(queue.claimNextPendingJob()).toBeUndefined();
  });

  it('does not return a retry until its next attempt is due', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);
    expect(queue.markUploading(1)).toBe(true);

    const retryAt = new Date('2030-01-01T00:00:30.000Z');
    expect(
      queue.scheduleRetry(1, 'Server unavailable', retryAt),
    ).toBe(true);

    expect(
      queue.getNextPendingJob(new Date('2030-01-01T00:00:29.999Z')),
    ).toBeUndefined();
    expect(queue.getNextPendingJob(retryAt)).toMatchObject({
      id: 1,
      status: 'pending',
      retryCount: 1,
      lastError: 'Server unavailable',
      nextAttemptAt: retryAt.toISOString(),
    });
  });

  it('returns a blocked job when its retry time is due', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);
    queue.markUploading(1);

    const retryAt = new Date('2030-01-01T00:05:00.000Z');
    expect(queue.scheduleBlocked(1, 'Forbidden', retryAt)).toBe(true);
    expect(
      queue.getNextPendingJob(new Date('2030-01-01T00:04:59.999Z')),
    ).toBeUndefined();
    expect(queue.getNextPendingJob(retryAt)).toMatchObject({
      id: 1,
      status: 'blocked',
      retryCount: 1,
      lastError: 'Forbidden',
    });
    expect(queue.claimNextPendingJob(retryAt)).toMatchObject({
      id: 1,
      status: 'uploading',
    });
  });

  it('recovers previously failed authorization jobs as blocked', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    const databasePath = path.join(temporaryFolder, 'agent.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE upload_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO upload_jobs (
        filename,
        file_path,
        size_bytes,
        status,
        retry_count,
        last_error,
        created_at
      )
      VALUES (
        'blocked.pdf',
        'C:\\files\\blocked.pdf',
        100,
        'failed',
        1,
        'Upload request failed with HTTP 403',
        '2026-06-15T00:00:00.000Z'
      );
    `);
    database.close();

    queue = new UploadQueue(databasePath);

    expect(queue.getJob(1)).toMatchObject({
      status: 'blocked',
      retryCount: 1,
    });
  });

  it('recovers interrupted uploading jobs after restart', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    queue = new UploadQueue(path.join(temporaryFolder, 'agent.db'));
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);
    queue.markUploading(1);

    const recoveredAt = new Date('2030-01-01T00:00:00.000Z');
    expect(queue.recoverInterruptedJobs(recoveredAt)).toBe(1);
    expect(queue.getNextPendingJob(recoveredAt)).toMatchObject({
      id: 1,
      status: 'pending',
      lastError: 'Upload interrupted before completion',
      nextAttemptAt: recoveredAt.toISOString(),
    });
  });

  it('migrates an existing queue without losing its jobs', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    const databasePath = path.join(temporaryFolder, 'agent.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE upload_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO upload_jobs (
        filename,
        file_path,
        size_bytes,
        created_at
      )
      VALUES (
        'existing.pdf',
        'C:\\files\\existing.pdf',
        100,
        '2026-06-15T00:00:00.000Z'
      );
    `);
    database.close();

    queue = new UploadQueue(databasePath);

    expect(
      queue.getNextPendingJob(new Date('2026-06-15T00:00:01.000Z')),
    ).toMatchObject({
      id: 1,
      filename: 'existing.pdf',
      detectedAt: '2026-06-15T00:00:00.000Z',
      nextAttemptAt: '2026-06-15T00:00:00.000Z',
    });
  });

  it('records a failed upload and increments its retry count', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'queue-test-'),
    );

    const databasePath = path.join(temporaryFolder, 'agent.db');
    queue = new UploadQueue(databasePath);
    queue.addJob('report.pdf', 'C:\\files\\report.pdf', 2048);
    queue.markUploading(1);

    expect(queue.markFailed(1, 'Server unavailable')).toBe(true);
    queue.close();
    queue = undefined;

    const database = new Database(databasePath, { readonly: true });
    const job = database
      .prepare(`
        SELECT status, retry_count, last_error
        FROM upload_jobs
        WHERE id = 1
      `)
      .get() as Pick<
        UploadJobRow,
        'status' | 'retry_count' | 'last_error'
      >;
    database.close();

    expect(job).toEqual({
      status: 'failed',
      retry_count: 1,
      last_error: 'Server unavailable',
    });
  });
});
