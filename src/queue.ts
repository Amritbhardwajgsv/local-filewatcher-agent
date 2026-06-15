import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type UploadJobStatus =
  | 'pending'
  | 'uploading'
  | 'completed'
  | 'failed';

export interface UploadJob {
  id: number;
  filename: string;
  filePath: string;
  sizeBytes: number;
  status: UploadJobStatus;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  detectedAt: string;
  nextAttemptAt: string;
  completedAt: string | null;
}

export class UploadQueue {
  private readonly db: Database.Database;

  constructor(databasePath = './data/agent.db') {
    const absolutePath = path.resolve(databasePath);

    fs.mkdirSync(path.dirname(absolutePath), {
      recursive: true,
    });

    this.db = new Database(absolutePath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upload_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        detected_at TEXT,
        next_attempt_at TEXT,
        completed_at TEXT
      )
    `);

    this.migrateSchema();
  }

  addJob(
    filename: string,
    filePath: string,
    sizeBytes: number,
    detectedAt = new Date(),
  ): void {
    const createdAt = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO upload_jobs (
          filename,
          file_path,
          size_bytes,
          created_at,
          detected_at,
          next_attempt_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        filename,
        filePath,
        sizeBytes,
        createdAt,
        detectedAt.toISOString(),
        createdAt,
      );
  }

  getNextPendingJob(now = new Date()): UploadJob | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          filename,
          file_path AS filePath,
          size_bytes AS sizeBytes,
          status,
          retry_count AS retryCount,
          last_error AS lastError,
          created_at AS createdAt,
          COALESCE(detected_at, created_at) AS detectedAt,
          COALESCE(next_attempt_at, created_at) AS nextAttemptAt,
          completed_at AS completedAt
        FROM upload_jobs
        WHERE status = 'pending'
          AND COALESCE(next_attempt_at, created_at) <= ?
        ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC
        LIMIT 1
      `)
      .get(now.toISOString()) as UploadJob | undefined;
  }

  claimNextPendingJob(now = new Date()): UploadJob | undefined {
    const claim = this.db.transaction((claimTime: Date) => {
      const job = this.getNextPendingJob(claimTime);

      if (!job || !this.markUploading(job.id)) {
        return undefined;
      }

      return {
        ...job,
        status: 'uploading' as const,
        lastError: null,
      };
    });

    return claim(now);
  }

  markUploading(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'uploading',
          last_error = NULL
        WHERE id = ? AND status = 'pending'
      `)
      .run(id);

    return result.changes === 1;
  }

  markCompleted(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'completed',
          last_error = NULL,
          completed_at = ?
        WHERE id = ? AND status = 'uploading'
      `)
      .run(new Date().toISOString(), id);

    return result.changes === 1;
  }

  scheduleRetry(
    id: number,
    error: string,
    nextAttemptAt: Date,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'pending',
          retry_count = retry_count + 1,
          last_error = ?,
          next_attempt_at = ?
        WHERE id = ? AND status = 'uploading'
      `)
      .run(error, nextAttemptAt.toISOString(), id);

    return result.changes === 1;
  }

  markFailed(id: number, error: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'failed',
          retry_count = retry_count + 1,
          last_error = ?
        WHERE id = ? AND status = 'uploading'
      `)
      .run(error, id);

    return result.changes === 1;
  }

  recoverInterruptedJobs(now = new Date()): number {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'pending',
          last_error = 'Upload interrupted before completion',
          next_attempt_at = ?
        WHERE status = 'uploading'
      `)
      .run(now.toISOString());

    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private migrateSchema(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(upload_jobs)')
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    const migrations = [
      {
        name: 'detected_at',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN detected_at TEXT',
      },
      {
        name: 'next_attempt_at',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN next_attempt_at TEXT',
      },
      {
        name: 'completed_at',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN completed_at TEXT',
      },
    ];

    for (const migration of migrations) {
      if (!columnNames.has(migration.name)) {
        this.db.exec(migration.sql);
      }
    }

    this.db.exec(`
      UPDATE upload_jobs
      SET
        detected_at = COALESCE(detected_at, created_at),
        next_attempt_at = COALESCE(next_attempt_at, created_at)
    `);
  }
}
