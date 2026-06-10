import { loadConfig } from './config';
import { createLogger, getLogger } from './logger';
import { FolderWatcher, type DetectedFile } from './watcher';
import {UploadQueue} from './queue';

const uploadQueue = new UploadQueue();

function main(): void {
  let loadedConfig: ReturnType<typeof loadConfig>;

  try {
    loadedConfig = loadConfig('./config.yaml');
  } catch (error) {
    console.error(
      '[FATAL] Failed to load config:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }

  const { config, secrets } = loadedConfig;
  const logger = createLogger(config);

  logger.info('Tender agent starting', {
    event: 'agent_start',
    agent_id: secrets.agentId,
    version: '1.0.0',
    node_version: process.version,
    platform: process.platform,
  });

  function onFileDetected(file: DetectedFile): void {
    getLogger().info('File ready for processing', {
      event: 'file_queued',
      file: file.filename,
      size_mb: (file.sizeBytes / (1024 * 1024)).toFixed(2),
    });
    uploadQueue.addJob(file.filename, file.fullPath, file.sizeBytes);
  }

  const watcher = new FolderWatcher(config, onFileDetected);
  watcher.start();

  logger.info('Agent is running - waiting for documents', {
    event: 'agent_ready',
    watching: config.watched_folders.map((folder) => folder.path),
  });

  function shutdown(signal: string): void {
    getLogger().info(`Received ${signal} - shutting down`, {
      event: 'agent_shutdown',
      signal,
    });
    uploadQueue.close();
    watcher.stop();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    getLogger().error('Uncaught exception', {
      event: 'uncaught_exception',
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
}

main();
