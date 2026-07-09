const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const db = require("./history");

const SCRAPER = path.join(__dirname, "scraper.js");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: "IREPS Tender Downloader",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC: Login status ─────────────────────────────────────────────────────────
ipcMain.handle("check-login", async () => {
  const cookies = await session.defaultSession.cookies.get({ domain: "ireps.gov.in" });
  return cookies.some((c) => c.name === "JSESSIONID");
});

// ── IPC: Open login window ────────────────────────────────────────────────────
ipcMain.handle("open-login", async () => {
  const loginWin = new BrowserWindow({
    width: 950,
    height: 720,
    title: "Login — IREPS",
    webPreferences: { contextIsolation: true },
  });
  loginWin.setMenuBarVisibility(false);
  loginWin.loadURL("https://ireps.gov.in/epsn/guestLogin.do");

  let notified = false;

  async function checkIfLoggedIn() {
    if (notified || loginWin.isDestroyed()) return;
    try {
      const url = loginWin.webContents.getURL();
      if (!url.includes("ireps.gov.in")) return;
      // Any IREPS page that is NOT the login/error page = user logged in
      const onLoginPage = /guestLogin|Login\.do|loginError/i.test(url);
      if (onLoginPage) return;
      const cookies = await session.defaultSession.cookies.get({ domain: "ireps.gov.in" });
      if (!cookies.some((c) => c.name === "JSESSIONID")) return;

      notified = true;
      if (!loginWin.isDestroyed()) loginWin.close();
      mainWindow.webContents.send("login-success");
    } catch (_) {}
  }

  // Detect via navigation events
  loginWin.webContents.on("did-navigate", () => checkIfLoggedIn());
  loginWin.webContents.on("did-navigate-in-page", () => checkIfLoggedIn());
  loginWin.webContents.on("did-frame-finish-load", () => checkIfLoggedIn());

  // Fallback poll every 1.5 s in case events are missed
  const poll = setInterval(() => {
    if (notified || loginWin.isDestroyed()) { clearInterval(poll); return; }
    checkIfLoggedIn();
  }, 1500);

  loginWin.on("closed", () => clearInterval(poll));
});

// ── IPC: Process tenders ──────────────────────────────────────────────────────
ipcMain.handle("process-tenders", async (_, tenderNumbers) => {
  const valid = tenderNumbers.map((t) => t.trim()).filter(Boolean);
  if (!valid.length) return [];
  if (!fs.existsSync(SCRAPER)) {
    const missing = valid.map((tenderNo) => ({
      type: "result",
      tenderNo,
      status: "error",
      files: [],
      error: "scraper.js is missing from the manager app package.",
    }));
    missing.forEach((msg) => mainWindow.webContents.send("tender-status", msg));
    return missing;
  }

  const cookies = await session.defaultSession.cookies.get({ url: "https://ireps.gov.in" });
  const cookieFile = path.join(app.getPath("temp"), "ireps-session.json");
  fs.writeFileSync(cookieFile, JSON.stringify(cookies));

  return new Promise((resolve) => {
    const results = [];

    const child = spawn(process.execPath, [SCRAPER, cookieFile, ...valid], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "status") {
            mainWindow.webContents.send("tender-status", msg);
          } else if (msg.type === "result") {
            results.push(msg);
            mainWindow.webContents.send("tender-status", msg);
            // Persist to history
            db.add({
              tenderNo: msg.tenderNo,
              status: msg.status,
              files: msg.files || [],
              error: msg.error || null,
              downloadedAt: new Date().toISOString(),
            });
          }
        } catch (_) {}
      }
    });

    child.stderr.on("data", (d) => console.error("[scraper]", d.toString().trim()));
    child.on("exit", () => {
      try { fs.unlinkSync(cookieFile); } catch (_) {}
      resolve(results);
    });
    child.on("error", (err) => {
      console.error("[scraper] spawn error:", err);
      resolve(results);
    });
  });
});

// ── IPC: History ──────────────────────────────────────────────────────────────
ipcMain.handle("get-history", () => db.getAll());
ipcMain.handle("get-stats", () => db.getStats());
ipcMain.handle("clear-history", () => db.clear());

// ── IPC: Open folder in Explorer ──────────────────────────────────────────────
ipcMain.handle("open-folder", async (_, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  else shell.openPath("C:\\Users\\Public\\Documents\\Tender Uploads");
});
