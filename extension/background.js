importScripts("core.js");

const core = globalThis.FlightMonitorCore;
const DATE_ALARM_PREFIX = "flight-monitor-date:";
const TIMEOUT_ALARM_PREFIX = "flight-monitor-timeout:";
const CHECK_TIMEOUT_MINUTES = 1.75;
const RECOVERY_COOLDOWN_MINUTES = 30;
let monitorStateWrites = Promise.resolve();
let resultQueue = Promise.resolve();

function enqueueResult(operation) {
  const result = resultQueue.then(operation, operation);
  resultQueue = result.catch(() => {});
  return result;
}
const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJISURBVHhe7dZtautKGAThrCJbzfKVDDhgTEdfBGvUVQ3Pn4vfAUFxcj8+v5ZFXAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAIcIYCz9dxUG8NfSb1UWwNbSDR0qgLF0R4b5E/C7dEOGC2As3VEhAxhLt0R1AQx7lu6IsAGMpVsaA4BDBzCW7kkqAxiOLN1TGMDP0j2FATyW3iCoDWA4snRPYABPS2+0M4CXpXeaVQcwHF16o5kBhKV3Wk0XwNrS77ecWXqn1a0CGEs3a84uvdVoyj8BW0s3a84uvdXGAFaW3mpzywDuuPSdM5gygKF16VuvZAAXLH3vVaYNYGhd+tar+C/ABUvfexUDePPSt17JAN689K1XmjKAxqXvnMEtA0g3a84uvdXmdgGk3285s/ROo+kCWFv6/R5nlt5pVB/AmaV3Wk35J+A/nVl6p5UBvCy90aw6gKNLb7QzgKelN9oZwGPpnqA2gCNL9xQG8LN0T4EPIN2SoANIdzSVAexduqXBBpDuiAwAri6APUt3VLgA0g2ZAcBVBbC1dEOHCSD9XgaAV/f/ADrGAOAMAM4A4AwAzgDgDADOAOAMAM4A4AwAzgDADOAOAMAM4A4AwAzgDgDADOAOAMAM4A4AwAzgDgDADOAOAMAM4A4AwAzgDgDADOAOAMAM4A4AwAzgDgDADOAOAMAG1ZvgH6BjR7W8TJ6AAAAABJRU5ErkJggg==";

async function ensureSettings() {
  const stored = await chrome.storage.local.get(["settings", "pushPlusToken"]);
  if (stored.settings) return core.normalizeSettings(stored.settings);
  const settings = core.defaultSettings();
  if (stored.pushPlusToken) settings.notifications.pushPlusToken = stored.pushPlusToken;
  await chrome.storage.local.set({ settings });
  return settings;
}

async function getState() {
  const stored = await chrome.storage.local.get(["settings", "monitorState", "priceHistory", "alertState"]);
  return {
    settings: core.normalizeSettings(stored.settings || core.defaultSettings()),
    monitorState: stored.monitorState || { byDate: {} },
    priceHistory: stored.priceHistory || {},
    alertState: stored.alertState || { targets: {} }
  };
}

async function setDateState(date, patch) {
  const operation = monitorStateWrites.then(async () => {
    const stored = await chrome.storage.local.get("monitorState");
    const monitorState = stored.monitorState || { byDate: {} };
    monitorState.byDate = { ...(monitorState.byDate || {}) };
    monitorState.byDate[date] = { ...(monitorState.byDate[date] || {}), ...patch };
    monitorState.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ monitorState });
    return monitorState;
  });
  monitorStateWrites = operation.catch(() => {});
  return operation;
}

async function setupAlarms(settingsInput) {
  const settings = core.normalizeSettings(settingsInput);
  const existing = await chrome.alarms.getAll();
  await Promise.all(existing
    .filter(alarm => alarm.name.startsWith(DATE_ALARM_PREFIX) || alarm.name.startsWith(TIMEOUT_ALARM_PREFIX))
    .map(alarm => chrome.alarms.clear(alarm.name)));
  if (!settings.enabled) return;
  const dates = core.dateRange(settings.startDate, settings.endDate);
  await Promise.all(dates.map((date, index) => chrome.alarms.create(`${DATE_ALARM_PREFIX}${date}`, {
    delayInMinutes: 0.25 + index * 0.25,
    periodInMinutes: 5
  })));
}

function dateFromUrl(url) {
  try {
    return new URL(url).searchParams.get("searchDepartureTime") || "";
  } catch {
    return "";
  }
}

async function getMonitorTab(date, settings, active = false) {
  const stored = await chrome.storage.local.get("monitorTabs");
  const monitorTabs = { ...(stored.monitorTabs || {}) };
  let tab = null;
  if (monitorTabs[date]) {
    try {
      const candidate = await chrome.tabs.get(monitorTabs[date]);
      if (dateFromUrl(candidate.url) === date) tab = candidate;
    } catch {}
  }
  if (!tab) {
    const candidates = await chrome.tabs.query({ url: "https://flight.qunar.com/site/oneway_list.htm*" });
    tab = candidates.find(candidate => dateFromUrl(candidate.url) === date) || null;
  }
  const url = core.buildSearchUrl(settings, date);
  if (!tab) tab = await chrome.tabs.create({ url, active });
  else if (tab.url !== url) tab = await chrome.tabs.update(tab.id, { url, active });
  else if (active) tab = await chrome.tabs.update(tab.id, { active: true });
  monitorTabs[date] = tab.id;
  await chrome.storage.local.set({ monitorTabs });
  return tab;
}

async function waitForTabReady(tabId, timeoutMs = 30000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch {
    return;
  }
  await new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function checkDate(date, { active = false } = {}) {
  const settings = await ensureSettings();
  if (!settings.enabled || !core.dateRange(settings.startDate, settings.endDate).includes(date)) {
    return { ok: false, skipped: true };
  }
  const state = await getState();
  const dateState = state.monitorState.byDate?.[date] || {};
  const age = dateState.lastAttemptAt ? Date.now() - new Date(dateState.lastAttemptAt).getTime() : Infinity;
  if (dateState.checking && age < CHECK_TIMEOUT_MINUTES * 60 * 1000) return { ok: false, busy: true };

  const requestId = `${date}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await setDateState(date, {
    checking: true,
    requestId,
    settingsRevision: settings.revision,
    status: "checking",
    message: "正在检查……",
    lastAttemptAt: new Date().toISOString()
  });
  await chrome.alarms.create(`${TIMEOUT_ALARM_PREFIX}${date}`, { delayInMinutes: CHECK_TIMEOUT_MINUTES });

  const tab = await getMonitorTab(date, settings, active);
  const latestSettings = await ensureSettings();
  if (latestSettings.revision !== settings.revision) return { ok: false, skipped: true };
  await setDateState(date, { tabId: tab.id });
  await waitForTabReady(tab.id);
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "runFlightCheck",
      date,
      requestId,
      settingsRevision: settings.revision,
      directOnly: settings.directOnly,
      refresh: true
    });
    if (!response?.accepted) throw new Error("监控页面没有响应");
  } catch {
    await setDateState(date, { message: "正在重新连接监控页面……" });
    await chrome.tabs.reload(tab.id);
    await waitForTabReady(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "runFlightCheck",
        date,
        requestId,
        settingsRevision: settings.revision,
        directOnly: settings.directOnly,
        refresh: false
      });
    } catch {}
  }
  return { ok: true };
}

async function sendPushPlus(settings, title, message) {
  const token = String(settings.notifications?.pushPlusToken || "").trim();
  if (!token) return { ok: false, skipped: true, message: "未配置 PushPlus" };
  try {
    const response = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title, content: message, template: "txt", channel: "wechat" }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || Number(result.code) !== 200) throw new Error(result.msg || `接口返回 ${result.code}`);
    await chrome.storage.local.set({ pushStatus: `微信发送成功：${new Date().toLocaleString("zh-CN", { hour12: false })}` });
    return { ok: true, message: "微信发送成功" };
  } catch (error) {
    const messageText = `微信发送失败：${error.message}`;
    await chrome.storage.local.set({ pushStatus: messageText });
    return { ok: false, message: messageText };
  }
}

async function notify(settings, title, message) {
  if (settings.notifications?.desktop !== false) {
    try {
      await chrome.notifications.create({ type: "basic", iconUrl: NOTIFICATION_ICON, title, message, priority: 2 });
    } catch {}
  }
  await sendPushPlus(settings, title, message);
}

function describeFlight(series) {
  const number = series.flightNo || series.flightNos?.join("+") || "航班";
  return `${series.airline || ""} ${number} ${series.depart || ""}-${series.arrive || ""}`.replace(/\s+/g, " ").trim();
}

async function updateBadge(monitorState) {
  const states = Object.values(monitorState.byDate || {});
  if (states.some(item => item.status === "error" || item.status === "needs-action")) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    return;
  }
  const prices = states
    .map(item => Number(item.bestPrice))
    .filter(Number.isFinite);
  if (!prices.length) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const best = Math.min(...prices);
  await chrome.action.setBadgeText({ text: String(best) });
  await chrome.action.setBadgeBackgroundColor({ color: "#1677ff" });
}

async function handleSuccess(message, sender) {
  const { settings, monitorState, priceHistory, alertState } = await getState();
  const date = message.date;
  const currentDateState = monitorState.byDate?.[date] || {};
  if (Number(message.settingsRevision || 0) !== Number(settings.revision || 0)) return;
  if (message.requestId && message.requestId !== currentDateState.requestId) return;
  await chrome.alarms.clear(`${TIMEOUT_ALARM_PREFIX}${date}`);
  const flights = (message.flights || []).filter(flight => Number.isFinite(flight.price));
  if (!flights.length) {
    await handleFailure(message.error || "没有识别到航班。", date, sender.tab?.id, Boolean(message.userActionRequired), message.requestId, message.settingsRevision);
    return;
  }

  const observedAt = new Date().toISOString();
  const recorded = core.appendHistory(priceHistory, date, flights, observedAt);
  const best = flights.slice().sort((a, b) => a.price - b.price)[0];
  const previousBest = Number(currentDateState.bestPrice);
  const nextMonitorState = await setDateState(date, {
    checking: false,
    requestId: null,
    status: "ok",
    message: `最低 ¥${best.price}，共 ${flights.length} 个航班`,
    lastCheckedAt: observedAt,
    bestPrice: best.price,
    bestFlight: best,
    flights,
    failureCount: 0,
    userActionRequired: false,
    tabId: sender.tab?.id || currentDateState.tabId
  });

  const targets = { ...(alertState.targets || {}) };
  const targetHits = [];
  if (settings.alerts.targetEnabled) {
    for (const flight of flights) {
      if (flight.price > settings.alerts.targetPrice) continue;
      const id = core.flightIdentity(date, flight);
      if (!Number.isFinite(targets[id]) || flight.price < targets[id]) targetHits.push({ id, flight });
      targets[id] = flight.price;
    }
  }
  await chrome.storage.local.set({ priceHistory: recorded.history, alertState: { ...alertState, targets } });
  await updateBadge(nextMonitorState);

  const route = `${settings.route.fromCity}→${settings.route.toCity}`;
  if (targetHits.length) {
    const hit = targetHits.sort((a, b) => a.flight.price - b.flight.price)[0];
    await notify(settings, `目标价已出现：¥${hit.flight.price}`, `${date} ${route}；${describeFlight(hit.flight)}。心仪价 ¥${settings.alerts.targetPrice}`);
  } else if (settings.alerts.notifyDrops && recorded.changes.length) {
    const drop = recorded.changes.sort((a, b) => (b.previousPrice - b.price) - (a.previousPrice - a.price))[0];
    await notify(settings, `航班降价：¥${drop.previousPrice} → ¥${drop.price}`, `${date} ${route}；${describeFlight(drop.flight)}`);
  } else if (settings.alerts.notifyDrops && Number.isFinite(previousBest) && best.price < previousBest) {
    await notify(settings, `当日最低价下降：¥${previousBest} → ¥${best.price}`, `${date} ${route}；${describeFlight(best)}`);
  }
}

async function maybeRecover(date, tabId, failureCount, userActionRequired) {
  if (!tabId || userActionRequired || failureCount < 2) return;
  const state = await getState();
  const lastRecoveryAt = state.monitorState.byDate?.[date]?.lastRecoveryAt;
  const elapsed = lastRecoveryAt ? Date.now() - new Date(lastRecoveryAt).getTime() : Infinity;
  if (elapsed < RECOVERY_COOLDOWN_MINUTES * 60 * 1000) return;
  try {
    await setDateState(date, { lastRecoveryAt: new Date().toISOString(), message: "连续失败，正在自动恢复页面……" });
    await chrome.tabs.reload(tabId);
  } catch {}
}

async function handleFailure(error, date, tabId, userActionRequired = false, requestId = null, settingsRevision = null) {
  await chrome.alarms.clear(`${TIMEOUT_ALARM_PREFIX}${date}`);
  const state = await getState();
  const old = state.monitorState.byDate?.[date] || {};
  if (settingsRevision !== null && Number(settingsRevision || 0) !== Number(state.settings.revision || 0)) return;
  if (requestId && requestId !== old.requestId) return;
  const failureCount = (old.failureCount || 0) + 1;
  const next = await setDateState(date, {
    checking: false,
    requestId: null,
    status: userActionRequired ? "needs-action" : "error",
    message: error,
    lastCheckedAt: new Date().toISOString(),
    failureCount,
    userActionRequired,
    tabId: tabId || old.tabId
  });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  if (failureCount === 3) await notify(state.settings, "航班监控连续失败", `${date}：${error}`);
  await maybeRecover(date, tabId || old.tabId, failureCount, userActionRequired);
  await updateBadge(next);
}

async function saveSettings(input) {
  const validation = core.validateSettings(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  validation.settings.revision = Date.now();
  const oldStored = await chrome.storage.local.get(["settings", "monitorTabs", "monitorState", "alertState"]);
  const oldSettings = oldStored.settings ? core.normalizeSettings(oldStored.settings) : null;
  await chrome.storage.local.set({ settings: validation.settings });
  await setupAlarms(validation.settings);

  const newDates = new Set(core.dateRange(validation.settings.startDate, validation.settings.endDate));
  const monitorTabs = { ...(oldStored.monitorTabs || {}) };
  for (const [date, tabId] of Object.entries(monitorTabs)) {
    if (newDates.has(date)) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith("https://flight.qunar.com/site/oneway_list.htm")) await chrome.tabs.remove(tabId);
    } catch {}
    delete monitorTabs[date];
  }
  const monitorState = oldStored.monitorState || { byDate: {} };
  monitorState.byDate = Object.fromEntries(
    Object.entries(monitorState.byDate || {}).filter(([date]) => newDates.has(date))
  );
  const alertState = oldStored.alertState || { targets: {} };
  alertState.targets = Object.fromEntries(
    Object.entries(alertState.targets || {}).filter(([id]) => newDates.has(id.slice(0, 10)))
  );
  await chrome.storage.local.set({ monitorTabs, monitorState, alertState });
  if (!oldSettings || JSON.stringify(oldSettings.route) !== JSON.stringify(validation.settings.route)) {
    await chrome.storage.local.set({
      monitorState: { byDate: {} },
      priceHistory: {},
      alertState: { targets: {} }
    });
  }
  return { ok: true, settings: validation.settings };
}

async function runAllNow(active = false) {
  const settings = await ensureSettings();
  const dates = core.dateRange(settings.startDate, settings.endDate);
  const results = [];
  for (let index = 0; index < dates.length; index += 1) {
    results.push(await checkDate(dates[index], { active: active && index === 0 }));
  }
  return { ok: true, results };
}

async function initialize() {
  const settings = await ensureSettings();
  await setupAlarms(settings);
}

chrome.runtime.onInstalled.addListener(details => {
  initialize().then(() => {
    if (details.reason === "install") chrome.runtime.openOptionsPage();
  });
});
chrome.runtime.onStartup.addListener(() => initialize());
initialize().catch(() => {});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(DATE_ALARM_PREFIX)) {
    checkDate(alarm.name.slice(DATE_ALARM_PREFIX.length)).catch(() => {});
  } else if (alarm.name.startsWith(TIMEOUT_ALARM_PREFIX)) {
    const date = alarm.name.slice(TIMEOUT_ALARM_PREFIX.length);
    getState().then(state => {
      const item = state.monitorState.byDate?.[date];
      if (item?.checking) enqueueResult(() => handleFailure("页面检查超时，扩展稍后会自动恢复。", date, item.tabId, false, item.requestId, item.settingsRevision));
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "flightResult") {
    if (message.flights?.length) enqueueResult(() => handleSuccess(message, sender)).then(() => sendResponse({ ok: true }));
    else enqueueResult(() => handleFailure(message.error || "没有识别到航班。", message.date, sender.tab?.id, Boolean(message.userActionRequired), message.requestId, message.settingsRevision))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "saveSettings") {
    enqueueResult(() => saveSettings(message.settings)).then(sendResponse);
    return true;
  }
  if (message?.type === "runAllNow") {
    runAllNow(Boolean(message.active)).then(sendResponse);
    return true;
  }
  if (message?.type === "getState") {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === "openDashboard") {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "openMonitorDate") {
    ensureSettings().then(settings => getMonitorTab(message.date, settings, true)).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "testPushPlus") {
    const validation = core.validateSettings(message.settings);
    if (!validation.ok) sendResponse({ ok: false, message: validation.errors.join("；") });
    else sendPushPlus(validation.settings, "航班价格监控测试", "PushPlus 微信通知连接成功。")
      .then(sendResponse);
    return true;
  }
  return false;
});

chrome.notifications.onClicked.addListener(() => chrome.runtime.openOptionsPage());
