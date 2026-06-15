import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as yaml from 'js-yaml';
import { z } from 'zod';

// Defines the configuration for one folder monitored by the agent.
const WatchedFolderSchema = z.object({
  path: z.string().min(1, 'Folder path cannot be empty'),
  label: z.string().min(1, 'Folder label cannot be empty'),
  priority: z.number().int().min(1),
});

// Defines and validates the complete structure of config.yaml.
const ConfigSchema = z.object({
  agent: z.object({
    id: z.string().min(1, 'Agent ID cannot be empty'),
    heartbeat_interval_seconds: z.number().int().min(10).default(60),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  watched_folders: z
    .array(WatchedFolderSchema)
    .min(1, 'At least one watched folder must be configured'),
  validation: z.object({
    max_file_size_mb: z.number().int().min(1).max(500).default(100),
    allowed_extensions: z.array(z.string().startsWith('.')).min(1),
    rejected_folder: z.string().min(1).default('./rejected'),
    stability_check_interval_ms: z.number().int().min(100).default(500),
    stability_check_count: z.number().int().min(2).default(3),
  }),
  upload: z
    .object({
      request_timeout_ms: z.number().int().min(1000).default(60_000),
      max_attempts: z.number().int().min(1).default(5),
      initial_retry_delay_ms: z.number().int().min(100).default(5_000),
      max_retry_delay_ms: z.number().int().min(1000).default(300_000),
      blocked_retry_delay_ms: z.number().int().min(1000).default(300_000),
      worker_poll_interval_ms: z.number().int().min(100).default(1_000),
    })
    .default({
      request_timeout_ms: 60_000,
      max_attempts: 5,
      initial_retry_delay_ms: 5_000,
      max_retry_delay_ms: 300_000,
      blocked_retry_delay_ms: 300_000,
      worker_poll_interval_ms: 1_000,
    }),
  logging: z.object({
    dir: z.string().min(1).default('./logs'),
    max_files: z.string().min(1).default('14d'),
    max_size: z.string().min(1).default('20m'),
  }),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;
export type WatchedFolder = z.infer<typeof WatchedFolderSchema>;

export interface AgentSecrets {
  cloudApiUrl: string;
  cloudApiKey: string;
  agentId: string;
}

function loadSecrets(): AgentSecrets {
  const cloudApiUrl = process.env.CLOUD_API_URL;
  const cloudApiKey = process.env.CLOUD_API_KEY;
  const agentId = process.env.AGENT_ID;

  if (!cloudApiUrl) {
    throw new Error('Missing CLOUD_API_URL in .env');
  }

  if (!cloudApiKey) {
    throw new Error('Missing CLOUD_API_KEY in .env');
  }

  if (!agentId) {
    throw new Error('Missing AGENT_ID in .env');
  }

  return { cloudApiUrl, cloudApiKey, agentId };
}

export function loadConfig(
  configPath = './config.yaml',
  envPath = path.join(path.dirname(path.resolve(configPath)), '.env'),
): {
  config: AgentConfig;
  secrets: AgentSecrets;
} {
  const absolutePath = path.resolve(configPath);
  const configDirectory = path.dirname(absolutePath);

  dotenv.config({ path: path.resolve(envPath) });

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`config.yaml not found at: ${absolutePath}`);
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  const rawConfig = yaml.load(fileContent);
  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`config.yaml is invalid:\n${issues}`);
  }

  return {
    config: {
      ...result.data,
      watched_folders: result.data.watched_folders.map((folder) => ({
        ...folder,
        path: resolveConfigPath(configDirectory, folder.path),
      })),
      validation: {
        ...result.data.validation,
        rejected_folder: resolveConfigPath(
          configDirectory,
          result.data.validation.rejected_folder,
        ),
      },
      logging: {
        ...result.data.logging,
        dir: resolveConfigPath(
          configDirectory,
          result.data.logging.dir,
        ),
      },
    },
    secrets: loadSecrets(),
  };
}

function resolveConfigPath(baseDirectory: string, value: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(baseDirectory, value);
}
