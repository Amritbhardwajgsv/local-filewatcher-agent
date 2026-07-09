const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tenderManager", {
  checkLogin: () => ipcRenderer.invoke("check-login"),
  openLogin: () => ipcRenderer.invoke("open-login"),
  processTenders: (tenderNumbers) =>
    ipcRenderer.invoke("process-tenders", tenderNumbers),
  getHistory: () => ipcRenderer.invoke("get-history"),
  getStats: () => ipcRenderer.invoke("get-stats"),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  openFolder: (filePath) => ipcRenderer.invoke("open-folder", filePath),
  onTenderStatus: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("tender-status", listener);
    return () => ipcRenderer.removeListener("tender-status", listener);
  },
  onLoginSuccess: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("login-success", listener);
    return () => ipcRenderer.removeListener("login-success", listener);
  },
});
