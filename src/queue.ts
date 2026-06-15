import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type UploadJobStatus =
  | 'pending'
  | 'blocked'
  | 'uploading'
  | 'completed'
  | 'failed';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

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
  uploadSessionId: string | null;
  chunkSize: number | null;
  totalParts: number | null;
  uploadedParts: UploadedPart[];
}

interface UploadJobRow extends Omit<UploadJob, 'uploadedParts'> {
  uploadedParts: string | null;
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
        completed_at TEXT,
        upload_session_id TEXT,
        chunk_size INTEGER,
        total_parts INTEGER,
        uploaded_parts TEXT NOT NULL DEFAULT '[]'
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
    const row = this.db
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
          completed_at AS completedAt,
          upload_session_id AS uploadSessionId,
          chunk_size AS chunkSize,
          total_parts AS totalParts,
          uploaded_parts AS uploadedParts
        FROM upload_jobs
        WHERE status IN ('pending', 'blocked')
          AND COALESCE(next_attempt_at, created_at) <= ?
        ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC
        LIMIT 1
      `)
      .get(now.toISOString()) as UploadJobRow | undefined;

    return row ? this.mapJob(row) : undefined;
  }

  getJob(id: number): UploadJob | undefined {
    const row = this.db
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
          completed_at AS completedAt,
          upload_session_id AS uploadSessionId,
          chunk_size AS chunkSize,
          total_parts AS totalParts,
          uploaded_parts AS uploadedParts
        FROM upload_jobs
        WHERE id = ?
      `)
      .get(id) as UploadJobRow | undefined;

    return row ? this.mapJob(row) : undefined;
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
        WHERE id = ? AND status IN ('pending', 'blocked')
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

  scheduleBlocked(
    id: number,
    error: string,
    nextAttemptAt: Date,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'blocked',
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

  saveUploadSession(
    id: number,
    sessionId: string,
    chunkSize: number,
    totalParts: number,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          upload_session_id = ?,
          chunk_size = ?,
          total_parts = ?
        WHERE id = ? AND status = 'uploading'
      `)
      .run(sessionId, chunkSize, totalParts, id);

    return result.changes === 1;
  }

  saveUploadedPart(id: number, part: UploadedPart): boolean {
    const save = this.db.transaction(
      (jobId: number, uploadedPart: UploadedPart) => {
        const row = this.db
          .prepare(`
            SELECT uploaded_parts AS uploadedParts
            FROM upload_jobs
            WHERE id = ? AND status = 'uploading'
          `)
          .get(jobId) as { uploadedParts: string | null } | undefined;

        if (!row) {
          return false;
        }

        const parts = this.parseUploadedParts(row.uploadedParts);
        const existingIndex = parts.findIndex(
          (item) => item.partNumber === uploadedPart.partNumber,
        );

        if (existingIndex >= 0) {
          parts[existingIndex] = uploadedPart;
        } else {
          parts.push(uploadedPart);
        }

        parts.sort((left, right) => left.partNumber - right.partNumber);

        const result = this.db
          .prepare(`
            UPDATE upload_jobs
            SET uploaded_parts = ?
            WHERE id = ? AND status = 'uploading'
          `)
          .run(JSON.stringify(parts), jobId);

        return result.changes === 1;
      },
    );

    return save(id, part);
  }

  clearUploadSession(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          upload_session_id = NULL,
          chunk_size = NULL,
          total_parts = NULL,
          uploaded_parts = '[]'
        WHERE id = ?
      `)
      .run(id);

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
      {
        name: 'upload_session_id',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN upload_session_id TEXT',
      },
      {
        name: 'chunk_size',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN chunk_size INTEGER',
      },
      {
        name: 'total_parts',
        sql: 'ALTER TABLE upload_jobs ADD COLUMN total_parts INTEGER',
      },
      {
        name: 'uploaded_parts',
        sql: "ALTER TABLE upload_jobs ADD COLUMN uploaded_parts TEXT NOT NULL DEFAULT '[]'",
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

    this.db
      .prepare(`
        UPDATE upload_jobs
        SET
          status = 'blocked',
          next_attempt_at = ?
        WHERE status = 'failed'
          AND (
            last_error LIKE '%HTTP 401%'
            OR last_error LIKE '%HTTP 403%'
          )
      `)
      .run(new Date().toISOString());
  }

  private mapJob(row: UploadJobRow): UploadJob {
    return {
      ...row,
      uploadedParts: this.parseUploadedParts(row.uploadedParts),
    };
  }

  private parseUploadedParts(value: string | null): UploadedPart[] {
    if (!value) {
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(value);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(
        (part): part is UploadedPart =>
          typeof part === 'object' &&
          part !== null &&
          typeof (part as UploadedPart).partNumber === 'number' &&
          typeof (part as UploadedPart).etag === 'string',
      );
    } catch {
      return [];
    }
  }
}
