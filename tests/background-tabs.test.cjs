const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../extension/core.js");

const storage = {};
const tabs = new Map();
const removed = [];
let nextTabId = 1;

function selected(data, keys) {
  if (typeof keys === "string") return { [keys]: data[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
  return { ...data };
}

const chrome = {
  storage: {
    local: {
      get: async keys => selected(storage, keys),
      set: async patch => Object.assign(storage, patch)
    }
  },
  tabs: {
    create: async ({ url, active }) => {
      const tab = { id: nextTabId++, url, active, status: "complete" };
      tabs.set(tab.id, tab);
      return tab;
    },
    get: async id => {
      if (!tabs.has(id)) throw new Error("tab not found");
      return tabs.get(id);
    },
    query: async () => [...tabs.values()].filter(tab => tab.url.startsWith("https://flight.qunar.com/")),
    update: async (id, patch) => Object.assign(tabs.get(id), patch),
    remove: async ids => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        tabs.delete(id);
        removed.push(id);
      }
    },
    reload: async () => {},
    sendMessage: async () => ({ accepted: true }),
    onUpdated: { addListener() {}, removeListener() {} }
  },
  alarms: {
    getAll: async () => [],
    clear: async () => true,
    create: async () => {},
    onAlarm: { addListener() {} }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    openOptionsPage: async () => {}
  },
  notifications: {
    create: async () => {},
    onClicked: { addListener() {} }
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  }
};

const context = {
  AbortSignal,
  URL,
  URLSearchParams,
  chrome,
  clearTimeout,
  console,
  fetch: async () => ({ ok: true, json: async () => ({ code: 200 }) }),
  importScripts: () => { context.FlightMonitorCore = core; },
  setTimeout
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8"),
  context,
  { filename: "background.js" }
);

(async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  const settings = core.defaultSettings(new Date("2026-08-23T08:00:00+08:00"));
  const date = settings.startDate;

  const created = await context.getMonitorTab(date, settings, false);
  assert.equal(created.owned, true);
  assert.equal(tabs.has(created.tab.id), true);
  assert.equal(storage.monitorTabs[date].tabId, created.tab.id);
  assert.equal(storage.monitorTabs[date].owned, true);
  assert.equal(await context.releaseMonitorTab(date, created.tab.id), true);
  assert.equal(tabs.has(created.tab.id), false);
  assert.equal(removed.includes(created.tab.id), true);

  const userTab = {
    id: nextTabId++,
    url: core.buildSearchUrl(settings, date),
    active: false,
    status: "complete"
  };
  tabs.set(userTab.id, userTab);
  const reused = await context.getMonitorTab(date, settings, false);
  assert.equal(reused.tab.id, userTab.id);
  assert.equal(reused.owned, false);
  assert.equal(await context.releaseMonitorTab(date, userTab.id), false);
  assert.equal(tabs.has(userTab.id), true);

  process.stdout.write("2 background tab lifecycle tests passed\n");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
