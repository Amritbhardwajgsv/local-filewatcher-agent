const api = window.tenderManager;

const loginState = document.querySelector("#loginState");
const loginButton = document.querySelector("#loginButton");
const openFolderButton = document.querySelector("#openFolderButton");
const processButton = document.querySelector("#processButton");
const tenderInput = document.querySelector("#tenderInput");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const refreshButton = document.querySelector("#refreshButton");
const statusList = document.querySelector("#statusList");
const historyList = document.querySelector("#historyList");
const totalCount = document.querySelector("#totalCount");
const todayCount = document.querySelector("#todayCount");

function tenderNumbers() {
  return tenderInput.value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusClass(status) {
  if (/done|success|downloaded/i.test(status)) return "ok";
  if (/error|fail/i.test(status)) return "bad";
  return "busy";
}

function renderStatus(message) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `status-row ${statusClass(message.status || message.type)}`;
  row.innerHTML = `
    <strong>${message.tenderNo || "Tender"}</strong>
    <span>${message.status || message.type || "status"}</span>
    <small>${message.error || (message.files || []).join(", ") || ""}</small>
  `;
  if (message.files && message.files[0]) {
    row.addEventListener("click", () => api.openFolder(message.files[0]));
  }
  statusList.prepend(row);
}

function renderHistory(items) {
  historyList.innerHTML = "";
  if (!items.length) {
    historyList.innerHTML = '<p class="empty">No downloads yet.</p>';
    return;
  }

  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `history-row ${statusClass(item.status)}`;
    row.innerHTML = `
      <strong>${item.tenderNo}</strong>
      <span>${item.status}</span>
      <small>${new Date(item.downloadedAt).toLocaleString()}</small>
    `;
    if (item.files && item.files[0]) {
      row.addEventListener("click", () => api.openFolder(item.files[0]));
    }
    historyList.append(row);
  }
}

async function refreshLogin() {
  const loggedIn = await api.checkLogin();
  loginState.textContent = loggedIn ? "Logged in" : "Login required";
  loginState.className = `state ${loggedIn ? "ok" : "bad"}`;
}

async function refreshData() {
  const [history, stats] = await Promise.all([api.getHistory(), api.getStats()]);
  totalCount.textContent = stats.total || 0;
  todayCount.textContent = stats.todayCount || 0;
  renderHistory(history || []);
}

loginButton.addEventListener("click", () => api.openLogin());
openFolderButton.addEventListener("click", () => api.openFolder());
refreshButton.addEventListener("click", refreshData);

clearHistoryButton.addEventListener("click", async () => {
  await api.clearHistory();
  await refreshData();
});

processButton.addEventListener("click", async () => {
  const tenders = tenderNumbers();
  if (!tenders.length) return tenderInput.focus();
  processButton.disabled = true;
  try {
    const results = await api.processTenders(tenders);
    results.forEach(renderStatus);
    await refreshData();
  } finally {
    processButton.disabled = false;
  }
});

api.onTenderStatus(renderStatus);
api.onLoginSuccess(() => {
  refreshLogin();
});

refreshLogin();
refreshData();
