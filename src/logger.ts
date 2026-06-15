import * as fs from 'fs';
import * as path from 'path';
import * as winston from 'winston';
import type { AgentConfig } from './config';

let logger: winston.Logger;

export function createLogger(config: AgentConfig): winston.Logger {
  const logDir = path.resolve(config.logging.dir);
  fs.mkdirSync(logDir, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const logFilePath = path.join(logDir, `agent-${today}.log`);

  logger = winston.createLogger({
    level: config.agent.log_level,
    defaultMeta: { agent_id: config.agent.id },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf((info) => {
            const {
              timestamp,
              level,
              message,
              event,
              file,
              error,
              status_code: statusCode,
              attempt,
              job_id: jobId,
            } = info;
            let line = `[${timestamp}] [${level}] ${message}`;

            if (event) {
              line += ` | event: ${String(event)}`;
            }

            if (file) {
              line += ` | file: ${String(file)}`;
            }

            if (jobId !== undefined) {
              line += ` | job: ${String(jobId)}`;
            }

            if (attempt !== undefined) {
              line += ` | attempt: ${String(attempt)}`;
            }

            if (statusCode !== undefined) {
              line += ` | status: ${String(statusCode)}`;
            }

            if (error) {
              line += ` | error: ${String(error)}`;
            }

            return line;
          }),
        ),
      }),
      new winston.transports.File({
        filename: logFilePath,
      }),
    ],
  });

  return logger;
}

export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error('Logger not initialized. Call createLogger(config) first.');
  }

  return logger;
}
