const core = globalThis.FlightMonitorCore;
const cities = globalThis.FLIGHT_MONITOR_CITIES;
let currentState = null;
let toastTimer = null;

const $ = id => document.getElementById(id);

function cityLabel(city) {
  return `${city.name} (${city.code})`;
}

function resolveCity(value) {
  const input = String(value || "").trim();
  const exact = cities.find(city => city.label === input || city.name === input || city.code === input.toUpperCase());
  if (exact) return exact;
  const match = input.match(/^(.+?)\s*[（(]([A-Za-z]{3})[）)]$/);
  return match ? { name: match[1].trim(), code: match[2].toUpperCase() } : { name: input, code: "" };
}

function populateCities() {
  const options = cities.map(city => {
    const option = document.createElement("option");
    option.value = city.label;
    return option;
  });
  $("cityOptions").replaceChildren(...options);
}

function fillSettings(settings) {
  $("enabled").checked = settings.enabled;
  $("fromCity").value = cityLabel({ name: settings.route.fromCity, code: settings.route.fromCode });
  $("toCity").value = cityLabel({ name: settings.route.toCity, code: settings.route.toCode });
  $("startDate").value = settings.startDate;
  $("endDate").value = settings.endDate;
  $("directOnly").checked = settings.directOnly;
  $("notifyDrops").checked = settings.alerts.notifyDrops;
  $("targetEnabled").checked = settings.alerts.targetEnabled;
  $("targetPrice").value = settings.alerts.targetPrice;
  $("targetPrice").disabled = !settings.alerts.targetEnabled;
  $("desktop").checked = settings.notifications.desktop;
  $("pushToken").value = settings.notifications.pushPlusToken || "";
}

function collectSettings() {
  const from = resolveCity($("fromCity").value);
  const to = resolveCity($("toCity").value);
  return {
    enabled: $("enabled").checked,
    route: { fromCity: from.name, fromCode: from.code, toCity: to.name, toCode: to.code },
    startDate: $("startDate").value,
    endDate: $("endDate").value,
    directOnly: $("directOnly").checked,
    intervalMinutes: 5,
    alerts: {
      notifyDrops: $("notifyDrops").checked,
      targetEnabled: $("targetEnabled").checked,
      targetPrice: Number($("targetPrice").value)
    },
    notifications: {
      desktop: $("desktop").checked,
      pushPlusToken: $("pushToken").value.trim()
    }
  };
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  $("saveStatus").textContent = message;
  $("saveStatus").className = `toast show${error ? " error" : ""}`;
  toastTimer = setTimeout(() => { $("saveStatus").className = "toast"; }, 4200);
}

function statusLabel(status) {
  return ({ ok: "正常", checking: "检查中", error: "失败", "needs-action": "需验证", idle: "等待" })[status] || "等待";
}

function describeFlight(flight) {
  if (!flight) return "等待首次结果";
  return [flight.airline, flight.flightNo, `${flight.depart || ""}-${flight.arrive || ""}`]
    .filter(Boolean).join(" ");
}

function renderOverview(state) {
  const dates = core.dateRange(state.settings.startDate, state.settings.endDate);
  const cards = dates.map(date => {
    const item = state.monitorState.byDate?.[date] || {};
    const card = document.createElement("article");
    card.className = "overview-card";

    const top = document.createElement("div");
    top.className = "date";
    const dateText = document.createElement("strong");
    dateText.textContent = date;
    const status = document.createElement("span");
    status.className = `status ${item.status || "idle"}`;
    status.textContent = statusLabel(item.status || "idle");
    top.append(dateText, status);

    const price = document.createElement("strong");
    price.className = "price";
    price.textContent = Number.isFinite(item.bestPrice) ? `¥${item.bestPrice}` : "--";
    const detail = document.createElement("p");
    detail.textContent = item.bestFlight ? describeFlight(item.bestFlight) : (item.message || "尚未检查");
    const open = document.createElement("button");
    open.textContent = "打开该日期监控页面 →";
    open.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openMonitorDate", date }));
    card.append(top, price, detail, open);
    return card;
  });
  $("dateOverview").replaceChildren(...cards);
  $("lastUpdated").textContent = state.monitorState.updatedAt
    ? `更新于 ${new Date(state.monitorState.updatedAt).toLocaleString("zh-CN", { hour12: false })}`
    : "尚未检查";
}

function seriesLabel(series) {
  return `${series.date} · ${series.airline} ${series.flightNo || series.flightNos?.join("+") || "航班"} · ${series.depart}-${series.arrive}`;
}

function renderSeriesSelector(state) {
  const select = $("flightSeries");
  const previous = select.value;
  const selectedDates = new Set(core.dateRange(state.settings.startDate, state.settings.endDate));
  const entries = Object.values(state.priceHistory || {})
    .filter(series => selectedDates.has(series.date) && series.samples?.length)
    .sort((a, b) => a.date.localeCompare(b.date) || a.depart.localeCompare(b.depart));
  const options = entries.map(series => {
    const option = document.createElement("option");
    option.value = series.id;
    option.textContent = seriesLabel(series);
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无航班历史";
    options.push(option);
  }
  select.replaceChildren(...options);
  if (entries.some(series => series.id === previous)) select.value = previous;
  renderTrend(state);
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function renderChart(samples) {
  const width = 960;
  const height = 310;
  const margin = { left: 64, right: 26, top: 25, bottom: 44 };
  const prices = samples.map(sample => sample.price);
  const minRaw = Math.min(...prices);
  const maxRaw = Math.max(...prices);
  const padding = Math.max(10, Math.ceil((maxRaw - minRaw || 20) * .15));
  const min = Math.max(0, minRaw - padding);
  const max = maxRaw + padding;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = index => margin.left + (samples.length === 1 ? plotWidth / 2 : index / (samples.length - 1) * plotWidth);
  const y = price => margin.top + (max - price) / (max - min || 1) * plotHeight;
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });

  for (let index = 0; index <= 4; index += 1) {
    const price = Math.round(max - index / 4 * (max - min));
    const yPos = margin.top + index / 4 * plotHeight;
    svg.append(svgElement("line", { x1: margin.left, x2: width - margin.right, y1: yPos, y2: yPos, stroke: "#dfe6f0", "stroke-width": 1 }));
    const label = svgElement("text", { x: margin.left - 10, y: yPos + 4, "text-anchor": "end", fill: "#7d899a", "font-size": 11 });
    label.textContent = `¥${price}`;
    svg.append(label);
  }

  const points = samples.map((sample, index) => `${x(index)},${y(sample.price)}`).join(" ");
  const areaPoints = `${margin.left},${margin.top + plotHeight} ${points} ${width - margin.right},${margin.top + plotHeight}`;
  svg.append(svgElement("polygon", { points: areaPoints, fill: "rgba(22,119,255,.10)" }));
  svg.append(svgElement("polyline", { points, fill: "none", stroke: "#1677ff", "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  samples.forEach((sample, index) => {
    const dot = svgElement("circle", { cx: x(index), cy: y(sample.price), r: 4, fill: "#fff", stroke: "#1677ff", "stroke-width": 2 });
    const title = svgElement("title");
    title.textContent = `${new Date(sample.at).toLocaleString("zh-CN", { hour12: false })} · ¥${sample.price}`;
    dot.append(title);
    svg.append(dot);
  });
  const firstLabel = svgElement("text", { x: margin.left, y: height - 15, fill: "#7d899a", "font-size": 11 });
  firstLabel.textContent = new Date(samples[0].at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const lastLabel = svgElement("text", { x: width - margin.right, y: height - 15, "text-anchor": "end", fill: "#7d899a", "font-size": 11 });
  lastLabel.textContent = new Date(samples[samples.length - 1].at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  svg.append(firstLabel, lastLabel);
  $("chart").replaceChildren(svg);
}

function renderTrend(state) {
  const series = state.priceHistory?.[$("flightSeries").value];
  $("emptyTrend").hidden = Boolean(series);
  $("trendContent").hidden = !series;
  if (!series) return;
  const samples = series.samples.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
  const summary = core.summarizeSeries(series);
  $("statCurrent").textContent = `¥${summary.current}`;
  $("statMin").textContent = `¥${summary.min}`;
  $("statMax").textContent = `¥${summary.max}`;
  $("statChange").textContent = `${summary.change > 0 ? "+" : ""}${summary.change} 元`;
  renderChart(samples);

  const rows = samples.slice().reverse().map((sample, reverseIndex) => {
    const chronologicalIndex = samples.length - 1 - reverseIndex;
    const previous = samples[chronologicalIndex - 1];
    const change = previous ? sample.price - previous.price : null;
    const row = document.createElement("tr");
    const time = document.createElement("td");
    time.textContent = new Date(sample.at).toLocaleString("zh-CN", { hour12: false });
    const price = document.createElement("td");
    price.textContent = `¥${sample.price}`;
    const changeCell = document.createElement("td");
    changeCell.textContent = change === null ? "首次记录" : `${change > 0 ? "+" : ""}${change} 元`;
    if (change < 0) changeCell.style.color = "#13854a";
    if (change > 0) changeCell.style.color = "#c33b3f";
    row.append(time, price, changeCell);
    return row;
  });
  $("historyRows").replaceChildren(...rows);
}

async function refreshData() {
  currentState = await chrome.runtime.sendMessage({ type: "getState" });
  renderOverview(currentState);
  renderSeriesSelector(currentState);
  $("pushStatus").textContent = (await chrome.storage.local.get("pushStatus")).pushStatus || "";
}

async function save() {
  const settings = collectSettings();
  const result = await chrome.runtime.sendMessage({ type: "saveSettings", settings });
  if (!result.ok) {
    showToast(result.errors.join("；"), true);
    return false;
  }
  currentState.settings = result.settings;
  fillSettings(result.settings);
  showToast("设置已保存，监控计划已更新。", false);
  await refreshData();
  return true;
}

$("swap").addEventListener("click", () => {
  const from = $("fromCity").value;
  $("fromCity").value = $("toCity").value;
  $("toCity").value = from;
});
$("targetEnabled").addEventListener("change", () => { $("targetPrice").disabled = !$("targetEnabled").checked; });
$("save").addEventListener("click", save);
$("runNow").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  if (await save()) {
    await chrome.runtime.sendMessage({ type: "runAllNow", active: false });
    showToast("全部日期检查已启动，结果将自动更新。", false);
  }
  event.currentTarget.disabled = false;
});
$("testPush").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  $("pushStatus").textContent = "正在发送测试消息……";
  const result = await chrome.runtime.sendMessage({ type: "testPushPlus", settings: collectSettings() });
  $("pushStatus").textContent = result.message || (result.ok ? "发送成功" : "发送失败");
  event.currentTarget.disabled = false;
});
$("flightSeries").addEventListener("change", () => renderTrend(currentState));
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") refreshData(); });

async function initializePage() {
  populateCities();
  currentState = await chrome.runtime.sendMessage({ type: "getState" });
  fillSettings(currentState.settings);
  await refreshData();
}
initializePage();
