const core = globalThis.FlightMonitorCore;

function formatFlight(flight) {
  if (!flight) return "等待首次检查";
  return [flight.airline, flight.flightNo, `${flight.depart || ""}-${flight.arrive || ""}`]
    .filter(Boolean).join(" ");
}

async function load() {
  const { settings, monitorState } = await chrome.runtime.sendMessage({ type: "getState" });
  const dates = core.dateRange(settings.startDate, settings.endDate);
  document.getElementById("route").textContent = `${settings.route.fromCity} → ${settings.route.toCity}`;
  document.getElementById("range").textContent = `${settings.startDate} 至 ${settings.endDate} · ${settings.directOnly ? "仅直飞" : "全部航班"}`;
  const badge = document.getElementById("enabledBadge");
  badge.textContent = settings.enabled ? "监控中" : "已暂停";
  badge.classList.toggle("on", settings.enabled);

  const states = dates.map(date => ({ date, ...(monitorState.byDate?.[date] || {}) }));
  const priced = states.filter(item => Number.isFinite(item.bestPrice)).sort((a, b) => a.bestPrice - b.bestPrice);
  const best = priced[0];
  document.getElementById("bestPrice").textContent = best ? `¥${best.bestPrice}` : "--";
  document.getElementById("bestFlight").textContent = best ? `${best.date} · ${formatFlight(best.bestFlight)}` : "等待首次检查";

  const list = document.getElementById("dateList");
  list.replaceChildren(...states.map(item => {
    const row = document.createElement("div");
    row.className = "date-item";
    const status = item.status || "idle";
    const message = item.message || "尚未检查";

    const dateBlock = document.createElement("div");
    const dot = document.createElement("span");
    dot.className = `status-dot ${status}`;
    const dateLabel = document.createElement("strong");
    dateLabel.textContent = item.date.slice(5);
    dateBlock.append(dot, dateLabel);

    const priceBlock = document.createElement("div");
    const price = document.createElement("strong");
    price.textContent = Number.isFinite(item.bestPrice) ? `¥${item.bestPrice}` : "--";
    const detail = document.createElement("small");
    detail.textContent = message;
    detail.title = message;
    priceBlock.append(price, detail);
    row.append(dateBlock, priceBlock);

    const open = document.createElement("button");
    open.textContent = "打开";
    open.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openMonitorDate", date: item.date }));
    row.append(open);
    return row;
  }));
}

document.getElementById("check").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  document.getElementById("message").textContent = "正在启动全部日期检查……";
  await chrome.runtime.sendMessage({ type: "runAllNow", active: false });
  document.getElementById("message").textContent = "检查已启动，结果会自动更新。";
  event.currentTarget.disabled = false;
  await load();
});

document.getElementById("dashboard").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openDashboard" });
  window.close();
});

chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") load(); });
load();
