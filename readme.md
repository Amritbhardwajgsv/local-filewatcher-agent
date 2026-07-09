# Tender Agent

A Windows background service that watches a shared folder, validates tender
documents, queues them locally, and uploads them directly to Amazon S3 using
resumable multipart uploads.

The end user only needs to drop a file into the **Upload Tender Documents**
desktop folder. No terminal, AWS account, or manual upload step is required.

## How It Works

```text
User drops document
  -> file stability check
  -> extension and size validation
  -> durable SQLite queue
  -> backend creates multipart upload session
  -> agent uploads chunks directly to S3 with presigned URLs
  -> backend completes the upload
```

The backend never receives the document bytes. It authenticates each machine,
creates S3 multipart sessions, and issues short-lived presigned URLs.

## Features

- Watches one or more folders with Chokidar.
- Waits until a copied file stops changing before processing it.
- Accepts PDF, DOC, and DOCX files up to the configured size limit.
- Moves invalid or oversized files into a rejected folder.
- Stores all upload jobs and multipart progress in SQLite.
- Uploads file chunks directly to S3 using presigned URLs.
- Saves every uploaded part's ETag for restart-safe resume.
- Retries network, timeout, rate-limit, and server failures with backoff.
- Keeps authorization/configuration failures in a durable `blocked` state.
- Runs automatically as a Windows service through WinSW.
- Uses a unique, independently revocable API key for each machine.
- Includes structured JSON logs and automated tests.

## Queue States

| State | Meaning |
|---|---|
| `pending` | Waiting for the background worker |
| `uploading` | Currently initiating, uploading, or completing |
| `blocked` | Waiting for authentication or configuration recovery |
| `completed` | Successfully completed in S3 |
| `failed` | Permanent local error or exhausted retry policy |

Only validation failures are moved to the rejected folder. Upload failures
leave the source file in place.

## Repository Layout

```text
src/
  agent.ts             Application entry point
  watcher.ts           Detection, stability checks, and validation
  queue.ts             Durable SQLite queue and multipart state
  uploader.ts          Backend API and direct S3 part uploads
  upload-worker.ts     Background processing and retry policy
  config.ts            YAML and environment validation
  runtime.ts           Development and Windows-service paths
  logger.ts            Console and JSON file logging
  notification.ts      Windows validation warnings

packaging/
  build-windows.ps1    Builds the Windows distribution
  install.ps1          Installs and starts the Windows service
  uninstall.ps1        Removes the Windows service
  TenderAgentService.xml
  config.production.yaml

manager-app/           Desktop IREPS tender download manager

tests/                 Vitest test suite
```

## Requirements

For development:

- Node.js 22
- npm 10+
- Windows, Linux, or macOS

For an installed manager machine:

- Windows x64
- Administrator access during installation

Node.js does not need to be installed on the target machine because the
Windows package includes its own runtime.

## Local Development

```powershell
git clone https://github.com/Amritbhardwajgsv/local-filewatcher-agent.git
cd local-filewatcher-agent
npm install
Copy-Item .env.example .env
```

Configure `.env`:

```env
CLOUD_API_URL=https://tender-automation-api.onrender.com/api/v1
CLOUD_API_KEY=replace-with-this-machine-api-key
AGENT_ID=developer-laptop-01
```

The backend must contain an enabled agent record with the same agent ID and
API key.

Run the agent:

```powershell
npm run dev
```

Drop a fresh PDF, DOC, or DOCX file into:

```text
watched/
```

Successful processing produces `upload_started` and `upload_completed` log
events.

## Configuration

Development settings live in `config.yaml`:

```yaml
agent:
  id: "local-agent-01"
  heartbeat_interval_seconds: 60
  log_level: "info"

watched_folders:
  - path: "./watched"
    label: "Local documents"
    priority: 1

validation:
  max_file_size_mb: 100
  allowed_extensions:
    - ".pdf"
    - ".docx"
    - ".doc"
  rejected_folder: "./rejected"
  stability_check_interval_ms: 500
  stability_check_count: 3

upload:
  request_timeout_ms: 60000
  max_attempts: 5
  initial_retry_delay_ms: 5000
  max_retry_delay_ms: 300000
  blocked_retry_delay_ms: 300000
  worker_poll_interval_ms: 1000

logging:
  dir: "./logs"
  max_files: "14d"
  max_size: "20m"
```

Relative paths are resolved from the directory containing `config.yaml`.
When installed as a service, the writable runtime root is:

```text
C:\ProgramData\TenderAgent
```

## Multipart API Contract

The agent uses these backend endpoints:

```text
POST /api/v1/uploads/initiate
POST /api/v1/uploads/{sessionId}/parts/{partNumber}
PUT  {presigned S3 URL}
POST /api/v1/uploads/{sessionId}/complete
POST /api/v1/uploads/{sessionId}/abort
```

The agent sends its API key as:

```http
Authorization: Bearer <machine-api-key>
```

AWS credentials exist only on the backend. They are never stored in the agent
configuration or Windows package.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

The current test suite covers:

- Valid, invalid, oversized, and growing files
- SQLite schema migration and queue transitions
- Retry scheduling and blocked jobs
- Multipart chunk boundaries and ETag persistence
- Resume after interruption
- Completion and abort behavior

## Build The Windows Package

```powershell
npm run package:win
```

Output:

```text
release\TenderAgent-Windows-x64.zip
```

The ZIP contains:

- Compiled JavaScript
- Node.js x64 runtime
- Production dependencies and native `better-sqlite3`
- Desktop manager app and bundled Electron runtime
- WinSW Windows service wrapper
- Install and uninstall scripts
- Production configuration template

No `.env`, API key, SQLite database, watched files, rejected files, or logs
are included.

## Provision A Machine

Before installation, create a unique backend identity for the machine.
Example:

```text
Agent ID: manager-laptop-01
API key: shown once by the backend administration command
```

Store only the key hash in the backend. Never reuse one key across multiple
machines.

If a laptop is lost or decommissioned, revoke only that machine's key.

## Install On Windows

1. Download `TenderAgent-Windows-x64.zip` from the GitHub Release.
2. Extract it into a temporary directory.
3. Open PowerShell as Administrator in the extracted directory.
4. Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1 `
  -AgentId "manager-laptop-01"
```

5. Enter the machine API key at the hidden prompt.

The installer creates:

```text
C:\Program Files\TenderAgent
C:\ProgramData\TenderAgent
C:\Users\Public\Documents\Tender Uploads
```

It also:

- Registers the automatic **Tender Agent** Windows service.
- Configures service restart after failures.
- Protects the machine `.env` for SYSTEM and Administrators.
- Creates a public desktop shortcut named **Upload Tender Documents**.
- Creates a public desktop shortcut named **Manage Tender Downloads**.

## Verify An Installation

Check the service:

```powershell
Get-Service TenderAgent
```

It should report `Running`.

Drop a fresh document into:

```text
C:\Users\Public\Documents\Tender Uploads
```

Inspect logs:

```powershell
Get-Content `
  "C:\ProgramData\TenderAgent\logs\agent-$(Get-Date -Format yyyy-MM-dd).log" `
  -Tail 30
```

Confirm:

```text
upload_started
upload_completed
```

Finally, verify the object appears in the private S3 bucket.

## Uninstall

Run PowerShell as Administrator:

```powershell
powershell.exe -ExecutionPolicy Bypass -File `
  "C:\Program Files\TenderAgent\uninstall.ps1"
```

This preserves local configuration, queue data, and logs.

To remove those as well:

```powershell
powershell.exe -ExecutionPolicy Bypass -File `
  "C:\Program Files\TenderAgent\uninstall.ps1" -PurgeData
```

## Logs And Recovery

Installed logs:

```text
C:\ProgramData\TenderAgent\logs
```

Service-wrapper logs:

```text
C:\ProgramData\TenderAgent\service-logs
```

Upload progress is stored in:

```text
C:\ProgramData\TenderAgent\data\agent.db
```

After a restart, interrupted jobs return to the queue. Uploaded chunks with
saved ETags are skipped, so only missing parts are uploaded again.

## Security

- Keep the S3 bucket private with Block Public Access enabled.
- Use least-privilege IAM permissions on the backend.
- Store no AWS credentials on agent machines.
- Use a unique API key per machine.
- Rotate any credential exposed in logs, screenshots, chat, or Git.
- Keep `.env`, `data/`, `logs/`, `watched/`, `rejected/`, and `release/`
  outside version control.
- Distribute Windows builds through versioned GitHub Releases.

## Technology

| Purpose | Technology |
|---|---|
| Language/runtime | TypeScript, Node.js 22 |
| Folder monitoring | Chokidar |
| Durable queue | SQLite, better-sqlite3 |
| HTTP client | Axios |
| Cloud storage | Amazon S3 multipart uploads |
| Validation | Zod, js-yaml |
| Logging | Winston |
| Tests | Vitest |
| Windows service | WinSW |
| Packaging | PowerShell, bundled Node runtime |

## License

Internal use only.
