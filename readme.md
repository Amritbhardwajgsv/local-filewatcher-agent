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

---

## Build

```bash
# Compile TypeScript
npm run build

# Build Windows executable (requires pkg)
npm install -g pkg
pkg . --targets node18-win-x64 --output dist/tender-agent.exe

# Build Linux binary
pkg . --targets node18-linux-x64 --output dist/tender-agent-linux
```

---

## Deployment (Windows)

The agent ships as a single `.exe`. IT setup on each machine takes under 5 minutes.

**Step 1 — Create the agent folder**
```
C:\TenderAgent\
  tender-agent.exe
  config.yaml
  .env
```

**Step 2 — Edit `config.yaml`**
Set the correct `agent.id` and watched folder paths for this machine.

**Step 3 — Edit `.env`**
Paste in the `CLOUD_API_KEY` issued from the cloud dashboard for this agent.

**Step 4 — Register as a Windows Service**
```cmd
tender-agent.exe --install
```

The agent now starts automatically on every boot. To verify it's running, check **Services → TenderAgent** in Windows.

**To uninstall:**
```cmd
tender-agent.exe --uninstall
```

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