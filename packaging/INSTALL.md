# Tender Agent Windows Installation

1. Extract `TenderAgent-Windows-x64.zip`.
2. Open PowerShell as Administrator in the extracted folder.
3. Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1 `
  -AgentId "manager-laptop-01"
```

4. Enter the machine's API key at the secure prompt.

The installer creates:

```text
C:\Program Files\TenderAgent
C:\ProgramData\TenderAgent
C:\Users\Public\Documents\Tender Uploads
```

It also registers the automatic `Tender Agent` Windows service and creates
the public desktop shortcut `Upload Tender Documents`.

To uninstall while preserving the queue, configuration, and logs:

```powershell
powershell.exe -ExecutionPolicy Bypass -File `
  "C:\Program Files\TenderAgent\uninstall.ps1"
```

Add `-PurgeData` only when the local queue and logs should also be deleted.
