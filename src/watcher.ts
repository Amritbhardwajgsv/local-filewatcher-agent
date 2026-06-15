import { watch, type FSWatcher } from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './config';
import { getLogger } from './logger';
import {
  showFileSizeWarning,
  showinvalidfilewarning,
} from './notification';
export interface DetectedFile {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  detectedAt: Date;
}

export type OnFileDetected = (file: DetectedFile) => void;

export class FolderWatcher {
  private watcher: FSWatcher | null = null;
  private readonly config: AgentConfig;
  private readonly onFileDetected: OnFileDetected;
  private stopped = true;

  constructor(config: AgentConfig, onFileDetected: OnFileDetected) {
    this.config = config;
    this.onFileDetected = onFileDetected;
  }

  start(): void {
    const logger = getLogger();
    this.stopped = false;

    const folderPaths = this.config.watched_folders.map((folder) =>
      path.resolve(folder.path),
    );

    for (const folderPath of folderPaths) {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });

        logger.info(`Created missing folder: ${folderPath}`, {
          event: 'folder_created',
          folder: folderPath,
        });
      }
    }

    this.watcher = watch(folderPaths, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('add', (filePath) => {
      void this.handleFileAdded(filePath);
    });
  }

  stop(): void {
    this.stopped = true;

    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }

    getLogger().info('Stopped folder watcher', { event: 'watcher_stopped' });
  }

  private async waitForFileStability(
    filePath: string,
  ): Promise<fs.Stats | undefined> {
    const {
      stability_check_interval_ms: intervalMs,
      stability_check_count: requiredChecks,
    } = this.config.validation;

    let previousStats: fs.Stats;

    try {
      previousStats = fs.statSync(filePath);
    } catch {
      return undefined;
    }

    let stableChecks = 0;

    while (!this.stopped && stableChecks < requiredChecks) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });

      if (this.stopped) {
        return undefined;
      }

      let currentStats: fs.Stats;

      try {
        currentStats = fs.statSync(filePath);
      } catch {
        return undefined;
      }

      const unchanged =
        currentStats.size === previousStats.size &&
        currentStats.mtimeMs === previousStats.mtimeMs;

      if (unchanged) {
        stableChecks += 1;
      } else {
        stableChecks = 0;
        previousStats = currentStats;
      }
    }

    return previousStats;
  }

  private async handleFileAdded(filePath: string): Promise<void> {
    const logger = getLogger();

    const stableStats = await this.waitForFileStability(filePath);

    if (!stableStats) {
      if (!this.stopped) {
        logger.warn('File disappeared before becoming stable', {
          event: 'file_stability_failed',
          file: filePath,
        });
      }

      return;
    }

    const sizeBytes = stableStats.size;
    const extension = path.extname(filePath).toLowerCase();

    const allowedExtensions =
      this.config.validation.allowed_extensions.map((item) =>
        item.toLowerCase(),
      );

    if (!allowedExtensions.includes(extension)) {
      const filename = path.basename(filePath);

      showinvalidfilewarning(filename, allowedExtensions);

      try {
        const rejectedPath = this.moveToRejected(filePath);

        logger.warn(`Unsupported file moved to rejected folder: ${filename}`, {
          event: 'file_rejected',
          file: filename,
          extension,
          rejected_path: rejectedPath,
        });
      } catch (error) {
        logger.error(`Could not move unsupported file: ${filename}`, {
          event: 'file_rejection_failed',
          file: filename,
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }

    const maxFileSizeBytes =
      this.config.validation.max_file_size_mb * 1024 * 1024;

    if (sizeBytes > maxFileSizeBytes) {
      const filename = path.basename(filePath);

      showFileSizeWarning(
        filename,
        this.config.validation.max_file_size_mb,
      );

      try {
        const rejectedPath = this.moveToRejected(filePath);

        logger.warn(`Oversized file moved to rejected folder: ${filename}`, {
          event: 'file_too_large',
          file: filename,
          size_bytes: sizeBytes,
          max_size_mb: this.config.validation.max_file_size_mb,
          rejected_path: rejectedPath,
        });
      } catch (error) {
        logger.error(`Could not move oversized file: ${filename}`, {
          event: 'file_rejection_failed',
          file: filename,
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }

    const detected: DetectedFile = {
      filename: path.basename(filePath),
      fullPath: filePath,
      sizeBytes,
      detectedAt: new Date(),
    };

    this.onFileDetected(detected);
  }

  private moveToRejected(filePath: string): string {
    const rejectedDirectory = path.resolve(
      this.config.validation.rejected_folder,
    );
    fs.mkdirSync(rejectedDirectory, { recursive: true });

    const parsedPath = path.parse(filePath);
    let rejectedPath = path.join(rejectedDirectory, parsedPath.base);
    let copyNumber = 1;

    while (fs.existsSync(rejectedPath)) {
      rejectedPath = path.join(
        rejectedDirectory,
        `${parsedPath.name}-${copyNumber}${parsedPath.ext}`,
      );
      copyNumber += 1;
    }

    fs.renameSync(filePath, rejectedPath);
    return rejectedPath;
  }
}
