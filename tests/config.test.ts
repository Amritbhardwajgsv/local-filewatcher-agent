import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  let temporaryFolder: string;

  afterEach(() => {
    if (temporaryFolder) {
      fs.rmSync(temporaryFolder, {
        recursive: true,
        force: true,
      });
    }
  });

  it('loads a valid config file', () => {
    temporaryFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'config-test-'),
    );

    const configPath = path.join(
      temporaryFolder,
      'config.yaml',
    );

    fs.writeFileSync(
      configPath,
      `
agent:
  id: "test-agent"
  heartbeat_interval_seconds: 60
  log_level: "info"

watched_folders:
  - path: "./watched"
    label: "Test documents"
    priority: 1

validation:
  max_file_size_mb: 100
  allowed_extensions:
    - ".pdf"
    - ".docx"
  stability_check_interval_ms: 500
  stability_check_count: 3

logging:
  dir: "./logs"
  max_files: "14d"
  max_size: "20m"
`,
    );

    process.env.CLOUD_API_URL = 'https://example.com';
    process.env.CLOUD_API_KEY = 'test-key';
    process.env.AGENT_ID = 'test-agent';

    const result = loadConfig(configPath);

    expect(result.config.agent.id).toBe('test-agent');
    expect(
      result.config.validation.allowed_extensions,
    ).toContain('.pdf');
    expect(result.config.watched_folders[0].path).toBe(
      path.join(temporaryFolder, 'watched'),
    );
    expect(result.config.validation.rejected_folder).toBe(
      path.join(temporaryFolder, 'rejected'),
    );
    expect(result.config.logging.dir).toBe(
      path.join(temporaryFolder, 'logs'),
    );
    expect(result.config.upload).toEqual({
      request_timeout_ms: 60_000,
      max_attempts: 5,
      initial_retry_delay_ms: 5_000,
      max_retry_delay_ms: 300_000,
      blocked_retry_delay_ms: 300_000,
      worker_poll_interval_ms: 1_000,
    });
    expect(result.secrets.cloudApiKey).toBe('test-key');
  });

  it('throws when the config file is missing', () => {
    expect(() =>
      loadConfig('./missing-config.yaml'),
    ).toThrow('config.yaml not found');
  });
});
