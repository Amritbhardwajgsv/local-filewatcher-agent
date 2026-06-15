import * as path from 'path';

export interface RuntimePaths {
  homeDir: string;
  configPath: string;
  envPath: string;
  databasePath: string;
}

export function getRuntimePaths(): RuntimePaths {
  const homeDir = path.resolve(
    process.env.TENDER_AGENT_HOME ?? process.cwd(),
  );

  return {
    homeDir,
    configPath: path.resolve(
      process.env.TENDER_AGENT_CONFIG ??
        path.join(homeDir, 'config.yaml'),
    ),
    envPath: path.resolve(
      process.env.TENDER_AGENT_ENV ??
        path.join(homeDir, '.env'),
    ),
    databasePath: path.resolve(
      process.env.TENDER_AGENT_DATABASE ??
        path.join(homeDir, 'data', 'agent.db'),
    ),
  };
}
