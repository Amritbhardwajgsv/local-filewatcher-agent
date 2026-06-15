# Tender Agent — Local Document Ingestion Agent

A lightweight background service that monitors designated folders on your office machines, detects incoming tender and business documents, and securely uploads them to the cloud processing platform — with zero manual intervention.

---

## How it works

The agent runs silently as a Windows Service (or Linux daemon) on any machine that has access to your document folders. The moment a file is dropped into a watched folder, the agent validates it, records it to a local queue, and uploads it to the cloud platform. If the upload fails due to a network issue, it retries automatically with backoff. Every action is logged locally with a full audit trail.

```
Watched folder → Detect → Validate → Queue (SQLite) → Upload → Cloud platform
```

---

## Project structure

```
tender-agent/
├── src/
│   ├── agent.ts          # Entry point — bootstraps all modules
│   ├── watcher.ts        # Phase 1: folder watcher (chokidar)
│   ├── validator.ts      # Phase 2: stability check + file validation
│   ├── queue.ts          # Phase 3: SQLite job queue
│   ├── uploader.ts       # Phase 4: HTTPS uploader with retry
│   ├── orchestrator.ts   # Phase 5: config, heartbeat, shutdown
│   ├── logger.ts         # Winston logger (JSON, rotating)
│   └── config.ts         # Config loader + Zod schema validation
├── config.yaml           # Agent configuration (see below)
├── .env                  # Secrets — never commit this
├── .env.example          # Template for .env
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- Node.js 20 LTS
- npm 9+

> When shipped as a `.exe`, no prerequisites are needed on the target machine.

---

## Local development setup

```bash
# 1. Clone the repo
git clone https://github.com/your-org/tender-agent.git
cd tender-agent

# 2. Install dependencies
npm install

# 3. Copy env template and fill in your values
cp .env.example .env

# 4. Edit config.yaml — set your watched folders and cloud API URL

# 5. Run in development mode
npm run dev
```

---

## Configuration

All agent behaviour is controlled by `config.yaml`. This file lives next to the executable on the deployed machine.

```yaml
agent:
  id: "agent-hq-floor2"          # unique name for this machine
  heartbeat_interval_seconds: 60

watched_folders:
  - path: "C:/Documents/Tenders"
    label: "Tenders"
    priority: 1
  - path: "C:/Documents/Contracts"
    label: "Contracts"
    priority: 2

validation:
  max_file_size_mb: 100
  allowed_extensions:
    - ".pdf"
    - ".docx"
    - ".xlsx"
    - ".doc"
    - ".xls"
  stability_check_interval_ms: 500
  stability_check_count: 3

logging:
  dir: "./logs"
  max_files: "14d"
  max_size: "20m"
```

Secrets (`api_key`, `cloud_api_url`) go in `.env` — never in `config.yaml`.

```env
CLOUD_API_URL=https://your-platform.com/api/v1
CLOUD_API_KEY=sk-agt-xxxxxxxxxxxx
AGENT_ID=agent-hq-floor2
```

### Multipart upload API

The agent uploads file chunks directly to S3-compatible storage through
temporary URLs issued by the backend. AWS credentials must never be stored in
this repository or on an agent machine.

With `CLOUD_API_URL=http://localhost:3000/api/v1`, the agent uses:

```text
POST /uploads/initiate
POST /uploads/{sessionId}/parts/{partNumber}
PUT  {presigned S3 URL}
POST /uploads/{sessionId}/complete
POST /uploads/{sessionId}/abort
```

Completed part ETags are persisted in SQLite. After a network failure or
restart, completed parts are skipped and only missing chunks are uploaded.
Temporary failures preserve the multipart session; permanent failures and
exhausted retries call the abort endpoint.

Backend authorization and configuration failures (`401` or `403`) move the
job into a durable `blocked` state instead of rejecting the file. Blocked jobs
keep their multipart progress and retry in the background every five minutes.
Invalid file types and oversized files are still the only files moved to the
rejected folder.

---

## Build

```bash
# Compile TypeScript
npm run build

# Build the self-contained Windows x64 distribution
npm run package:win
```

The Windows package is written to:

```text
release/TenderAgent-Windows-x64.zip
```

It bundles the compiled agent, the matching Node.js runtime,
`better-sqlite3`, production dependencies, WinSW, and elevated
install/uninstall scripts. This layout is used instead of a single-file
executable because SQLite includes a native Windows module.

---

## Deployment (Windows)

1. Extract `TenderAgent-Windows-x64.zip`.
2. Open PowerShell as Administrator in the extracted directory.
3. Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1 `
  -AgentId "manager-laptop-01"
```

4. Enter the unique API key for that machine at the secure prompt.

The installer registers the automatic `Tender Agent` service and creates:

```text
C:\Program Files\TenderAgent
C:\ProgramData\TenderAgent
C:\Users\Public\Documents\Tender Uploads
```

It also creates the public desktop shortcut `Upload Tender Documents`.
See `packaging/INSTALL.md` for uninstall and data-retention instructions.

---

## Deployment (Linux / systemd)

```bash
# Copy binary
sudo cp tender-agent-linux /usr/local/bin/tender-agent
sudo chmod +x /usr/local/bin/tender-agent

# Create systemd service
sudo nano /etc/systemd/system/tender-agent.service
```

```ini
[Unit]
Description=Tender Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/tender-agent
WorkingDirectory=/opt/tender-agent
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable tender-agent
sudo systemctl start tender-agent
```

---

## Logs

Logs are written to the `./logs` directory next to the executable, in structured JSON format rotated daily.

```
logs/
  agent-2026-06-08.log
  agent-2026-06-07.log
  ...
```

Each log entry looks like:

```json
{
  "timestamp": "2026-06-08T10:42:01.000Z",
  "level": "info",
  "event": "file_detected",
  "agent_id": "agent-hq-floor2",
  "file": "tender_mumbai_2026.pdf",
  "path": "C:/Documents/Tenders/tender_mumbai_2026.pdf",
  "size_bytes": 2457600
}
```

---

## Build phases

| Phase | What it builds | Status |
|---|---|---|
| 1 | Folder watcher — detects new files | in progress |
| 2 | Stability check + file validator | planned |
| 3 | SQLite job queue + metadata recorder | planned |
| 4 | HTTPS uploader with retry + backoff | planned |
| 5 | Orchestrator, heartbeat, auto-update, Windows Service | planned |

---

## Tech stack

| Purpose | Package |
|---|---|
| Folder watching | `chokidar` |
| File type validation | `file-type` |
| Hashing | `crypto` (built-in) |
| Job queue | `better-sqlite3` |
| HTTP uploads | `axios` |
| Config schema | `zod` |
| Config file | `js-yaml` |
| Logging | `winston` |
| Windows Service | `node-windows` |
| Executable bundling | `pkg` |

---

## Security notes

- `config.yaml` and `.env` must never be committed to version control — both are in `.gitignore`
- API keys are transmitted over TLS 1.3 minimum
- Each agent machine has its own unique `api_key` — if a machine is decommissioned, revoke its key from the cloud dashboard
- File checksums (SHA-256) are verified end-to-end between agent and cloud

---

## Contributing

This is an internal tool. Raise a PR against `main`. All PRs require one reviewer approval before merge. Keep each PR scoped to one phase or one bug fix.

---

## License

Internal use only — © Frauscher Sensor technology Gmbh
