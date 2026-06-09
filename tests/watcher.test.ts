import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/notification', () => ({
  showFileSizeWarning: vi.fn(),
  showinvalidfilewarning: vi.fn(),
}));

import { FolderWatcher } from '../src/watcher';
import { createLogger } from '../src/logger';
import type { AgentConfig } from '../src/config';
import {
  showFileSizeWarning,
  showinvalidfilewarning,
} from '../src/notification';

describe('FolderWatcher', () => {
  let watcher: FolderWatcher | undefined;
  let temporaryFolder: string;

  afterEach(() => {
    watcher?.stop();

    if (temporaryFolder) {
      fs.rmSync(temporaryFolder, {
        recursive: true,
        force: true,
      });
    }
  });

  it('accepts a PDF file', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'watcher-test-'),
    );

    const config: AgentConfig = {
      agent: {
        id: 'test-agent',
        heartbeat_interval_seconds: 60,
        log_level: 'error',
      },
      watched_folders: [
        {
          path: temporaryFolder,
          label: 'Test folder',
          priority: 1,
        },
      ],
      validation: {
        max_file_size_mb: 100,
        allowed_extensions: ['.pdf', '.doc', '.docx'],
        rejected_folder: path.join(temporaryFolder, 'rejected'),
        stability_check_interval_ms: 100,
        stability_check_count: 2,
      },
      logging: {
        dir: temporaryFolder,
        max_files: '1d',
        max_size: '1m',
      },
    };

    createLogger(config);

    const onFileDetected = vi.fn();

    watcher = new FolderWatcher(config, onFileDetected);
    watcher.start();

    // Give Chokidar time to become ready.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const pdfPath = path.join(temporaryFolder, 'report.pdf');
    fs.writeFileSync(pdfPath, 'test PDF content');

    await vi.waitFor(() => {
      expect(onFileDetected).toHaveBeenCalledOnce();
    });

    expect(onFileDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'report.pdf',
        fullPath: pdfPath,
      }),
    );
  });

  it('moves an unsupported PNG file to the rejected folder', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'watcher-test-'),
    );

    const watchedFolder = path.join(temporaryFolder, 'watched');
    const rejectedFolder = path.join(temporaryFolder, 'rejected');
    fs.mkdirSync(watchedFolder);

    const config: AgentConfig = {
      agent: {
        id: 'test-agent',
        heartbeat_interval_seconds: 60,
        log_level: 'error',
      },
      watched_folders: [
        {
          path: watchedFolder,
          label: 'Test folder',
          priority: 1,
        },
      ],
      validation: {
        max_file_size_mb: 100,
        allowed_extensions: ['.pdf', '.doc', '.docx'],
        rejected_folder: rejectedFolder,
        stability_check_interval_ms: 100,
        stability_check_count: 2,
      },
      logging: {
        dir: temporaryFolder,
        max_files: '1d',
        max_size: '1m',
      },
    };

    createLogger(config);

    const onFileDetected = vi.fn();
    watcher = new FolderWatcher(config, onFileDetected);
    watcher.start();

    await new Promise((resolve) => setTimeout(resolve, 300));

    const sourcePath = path.join(watchedFolder, 'image.png');
    const rejectedPath = path.join(rejectedFolder, 'image.png');
    fs.writeFileSync(sourcePath, 'test image content');

    await vi.waitFor(() => {
      expect(fs.existsSync(rejectedPath)).toBe(true);
    });

    expect(onFileDetected).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(showinvalidfilewarning).toHaveBeenCalledWith(
      'image.png',
      ['.pdf', '.doc', '.docx'],
    );
  });

  it('moves an oversized PDF file to the rejected folder', async () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'watcher-test-'),
    );

    const watchedFolder = path.join(temporaryFolder, 'watched');
    const rejectedFolder = path.join(temporaryFolder, 'rejected');
    fs.mkdirSync(watchedFolder);

    const config: AgentConfig = {
      agent: {
        id: 'test-agent',
        heartbeat_interval_seconds: 60,
        log_level: 'error',
      },
      watched_folders: [
        {
          path: watchedFolder,
          label: 'Test folder',
          priority: 1,
        },
      ],
      validation: {
        max_file_size_mb: 1,
        allowed_extensions: ['.pdf', '.doc', '.docx'],
        rejected_folder: rejectedFolder,
        stability_check_interval_ms: 100,
        stability_check_count: 2,
      },
      logging: {
        dir: temporaryFolder,
        max_files: '1d',
        max_size: '1m',
      },
    };

    createLogger(config);

    const onFileDetected = vi.fn();
    watcher = new FolderWatcher(config, onFileDetected);
    watcher.start();

    await new Promise((resolve) => setTimeout(resolve, 300));

    const sourcePath = path.join(watchedFolder, 'large.pdf');
    const rejectedPath = path.join(rejectedFolder, 'large.pdf');
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024 + 1));

    await vi.waitFor(() => {
      expect(fs.existsSync(rejectedPath)).toBe(true);
    });

    expect(onFileDetected).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(showFileSizeWarning).toHaveBeenCalledWith('large.pdf', 1);
  });
});
