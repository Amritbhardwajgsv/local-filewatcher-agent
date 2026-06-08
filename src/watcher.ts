import { watch, type FSWatcher } from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './config';
import { getLogger } from './logger';

export interface DetectedFile {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  detectedAt: Date;
}

export type OnFileDetected = (file: DetectedFile) => void;

export class FolderWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly onFileDetected: OnFileDetected,
  ) {}

  start(): void {
    const logger = getLogger();
    const folderPaths = this.config.watched_folders.map((folder) =>
      path.resolve(folder.path),
    );

    for (const folderPath of folderPaths) {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        logger.info(`Created watched folder: ${folderPath}`, {
          event: 'folder_created',
          folder: folderPath,
        });
      }
    }

    this.watcher = watch(folderPaths, {
      awaitWriteFinish: {
        stabilityThreshold:
          this.config.validation.stability_check_interval_ms,
        pollInterval: 100,
      },
      ignored: /(^|[\/\\])(\.|~\$)/,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('add', (filePath) => {
      this.handleFileAdded(filePath);
    });

    this.watcher.on('error', (error) => {
      logger.error('Watcher error', {
        event: 'watcher_error',
        error: String(error),
      });
    });

    this.watcher.on('ready', () => {
      logger.info('All watched folders are ready', {
        event: 'watching',
        folders: folderPaths,
      });
    });
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
      getLogger().info('Watcher stopped', { event: 'watcher_stopped' });
    }
  }

  private handleFileAdded(filePath: string): void {
    const logger = getLogger();
    let sizeBytes: number;

    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {
      logger.warn('Could not read file - it may have been moved or deleted', {
        event: 'stat_failed',
        file: filePath,
      });
      return;
    }

    const detected: DetectedFile = {
      filename: path.basename(filePath),
      fullPath: filePath,
      sizeBytes,
      detectedAt: new Date(),
    };

    logger.info(`New file detected: ${detected.filename}`, {
      event: 'file_detected',
      file: detected.filename,
      path: detected.fullPath,
      size_mb: (detected.sizeBytes / (1024 * 1024)).toFixed(2),
      detected_at: detected.detectedAt.toISOString(),
    });

    this.onFileDetected(detected);
  }
}
