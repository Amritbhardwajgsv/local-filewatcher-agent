const fs = require("fs");
const path = require("path");
const { app } = require("electron");

let _path = null;
const filePath = () => _path || (_path = path.join(app.getPath("userData"), "tender-history.json"));

const read = () => {
  try { return JSON.parse(fs.readFileSync(filePath(), "utf8")); }
  catch { return []; }
};

const write = (data) => {
  try { fs.writeFileSync(filePath(), JSON.stringify(data)); }
  catch (_) {}
};

module.exports = {
  add(entry) {
    const h = read();
    h.unshift({ ...entry, id: Date.now() });
    if (h.length > 500) h.length = 500;
    write(h);
  },
  getAll(limit = 200) {
    return read().slice(0, limit);
  },
  getStats() {
    const all = read();
    const todayStr = new Date().toDateString();
    const today = all.filter((e) => new Date(e.downloadedAt).toDateString() === todayStr);
    return {
      total: all.filter((e) => e.status === "done").length,
      todayCount: today.filter((e) => e.status === "done").length,
    };
  },
  clear() { write([]); },
};
