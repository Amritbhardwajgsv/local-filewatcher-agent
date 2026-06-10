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
        created_at TEXT NOT NULL
      )
    `);
  }

  addJob(
    filename: string,
    filePath: string,
    sizeBytes: number,
  ): void {
    this.db
      .prepare(`
        INSERT INTO upload_jobs (
          filename,
          file_path,
          size_bytes,
          created_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(
        filename,
        filePath,
        sizeBytes,
        new Date().toISOString(),
      );
  }

  getNextPendingJob(): UploadJob | undefined {
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
          created_at AS createdAt
        FROM upload_jobs
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `)
      .get() as UploadJob | undefined;
  }

  markUploading(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET status = 'uploading', last_error = NULL
        WHERE id = ? AND status = 'pending'
      `)
      .run(id);

    return result.changes === 1;
  }

  markCompleted(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET status = 'completed', last_error = NULL
        WHERE id = ? AND status = 'uploading'
      `)
      .run(id);

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

  close(): void {
    this.db.close();
  }
}
