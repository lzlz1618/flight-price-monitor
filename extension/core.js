(function initializeCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FlightMonitorCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_RANGE_DAYS = 7;
  const MAX_SAMPLES_PER_FLIGHT = 240;
  const MAX_SERIES = 300;
  const SAMPLE_HEARTBEAT_MS = 60 * 60 * 1000;
  const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

  const pad = value => String(value).padStart(2, "0");

  function localIsoDate(value = new Date()) {
    const date = new Date(value);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function addDays(isoDate, count) {
    const date = new Date(`${isoDate}T12:00:00`);
    date.setDate(date.getDate() + count);
    return localIsoDate(date);
  }

  function dateRange(startDate, endDate, maxDays = MAX_RANGE_DAYS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) {
      throw new Error("请选择有效的开始和结束日期");
    }
    if (startDate > endDate) throw new Error("结束日期不能早于开始日期");
    const output = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      output.push(cursor);
      if (output.length > maxDays) throw new Error(`日期范围最多 ${maxDays} 天`);
      cursor = addDays(cursor, 1);
    }
    return output;
  }

  function defaultSettings(now = new Date()) {
    const tomorrow = addDays(localIsoDate(now), 1);
    return {
      revision: 0,
      enabled: true,
      route: {
        fromCity: "福州",
        fromCode: "FOC",
        toCity: "成都",
        toCode: "CTU"
      },
      startDate: tomorrow,
      endDate: addDays(tomorrow, 2),
      directOnly: true,
      intervalMinutes: 5,
      alerts: {
        notifyDrops: true,
        targetEnabled: false,
        targetPrice: 700
      },
      notifications: {
        desktop: true,
        pushPlusToken: ""
      }
    };
  }

  function cleanCode(value) {
    return String(value || "").trim().toUpperCase();
  }

  function normalizeSettings(input, now = new Date()) {
    const defaults = defaultSettings(now);
    const settings = {
      ...defaults,
      ...input,
      route: { ...defaults.route, ...(input?.route || {}) },
      alerts: { ...defaults.alerts, ...(input?.alerts || {}) },
      notifications: { ...defaults.notifications, ...(input?.notifications || {}) }
    };
    settings.route.fromCity = String(settings.route.fromCity || "").trim();
    settings.route.toCity = String(settings.route.toCity || "").trim();
    settings.route.fromCode = cleanCode(settings.route.fromCode);
    settings.route.toCode = cleanCode(settings.route.toCode);
    settings.intervalMinutes = 5;
    settings.revision = Number(settings.revision) || 0;
    settings.alerts.targetPrice = Number(settings.alerts.targetPrice);
    return settings;
  }

  function validateSettings(input) {
    const settings = normalizeSettings(input);
    const errors = [];
    if (!settings.route.fromCity) errors.push("请选择出发城市");
    if (!settings.route.toCity) errors.push("请选择到达城市");
    if (!/^[A-Z]{3}$/.test(settings.route.fromCode)) errors.push("出发城市机场代码必须是 3 位字母");
    if (!/^[A-Z]{3}$/.test(settings.route.toCode)) errors.push("到达城市机场代码必须是 3 位字母");
    if (settings.route.fromCode === settings.route.toCode) errors.push("出发城市和到达城市不能相同");
    try {
      dateRange(settings.startDate, settings.endDate);
    } catch (error) {
      errors.push(error.message);
    }
    if (settings.alerts.targetEnabled
      && (!Number.isFinite(settings.alerts.targetPrice) || settings.alerts.targetPrice < 1)) {
      errors.push("请输入有效的心仪价格");
    }
    return { ok: errors.length === 0, errors, settings };
  }

  function buildSearchUrl(settingsInput, date) {
    const settings = normalizeSettings(settingsInput);
    const params = new URLSearchParams({
      searchDepartureAirport: settings.route.fromCity,
      searchArrivalAirport: settings.route.toCity,
      searchDepartureTime: date,
      searchArrivalTime: addDays(date, 1),
      nextNDays: "0",
      startSearch: "true",
      fromCode: settings.route.fromCode,
      toCode: settings.route.toCode,
      from: "flight_dom_search"
    });
    return `https://flight.qunar.com/site/oneway_list.htm?${params.toString()}`;
  }

  function flightIdentity(date, flight) {
    const number = String(flight.flightNo || flight.flightNos?.join("+") || "UNKNOWN").replace(/\s+/g, "");
    const depart = String(flight.depart || "--:--");
    const arrive = String(flight.arrive || "--:--");
    return `${date}|${number}|${depart}|${arrive}`;
  }

  function appendHistory(historyInput, date, flights, observedAt = new Date().toISOString()) {
    const history = { ...(historyInput || {}) };
    const changes = [];
    const nowMs = new Date(observedAt).getTime();

    for (const flight of flights || []) {
      if (!Number.isFinite(flight.price)) continue;
      const id = flightIdentity(date, flight);
      const current = history[id] || {
        id,
        date,
        airline: flight.airline || "未知航司",
        flightNo: flight.flightNo || "",
        flightNos: flight.flightNos || (flight.flightNo ? [flight.flightNo] : []),
        depart: flight.depart || "",
        arrive: flight.arrive || "",
        direct: flight.direct !== false,
        samples: []
      };
      const samples = Array.isArray(current.samples) ? current.samples.slice() : [];
      const previous = samples[samples.length - 1] || null;
      const shouldRecord = !previous
        || previous.price !== flight.price
        || nowMs - new Date(previous.at).getTime() >= SAMPLE_HEARTBEAT_MS;
      if (shouldRecord) samples.push({ at: observedAt, price: flight.price });
      current.airline = flight.airline || current.airline;
      current.flightNo = flight.flightNo || current.flightNo;
      current.flightNos = flight.flightNos || current.flightNos;
      current.direct = flight.direct !== false;
      current.samples = samples.slice(-MAX_SAMPLES_PER_FLIGHT);
      current.lastSeenAt = observedAt;
      current.currentPrice = flight.price;
      history[id] = current;
      if (previous && flight.price < previous.price) {
        changes.push({ type: "drop", id, previousPrice: previous.price, price: flight.price, flight: current });
      }
    }

    const cutoff = nowMs - HISTORY_RETENTION_MS;
    const retained = Object.entries(history)
      .filter(([, series]) => new Date(series.lastSeenAt || 0).getTime() >= cutoff)
      .sort((a, b) => new Date(b[1].lastSeenAt || 0) - new Date(a[1].lastSeenAt || 0))
      .slice(0, MAX_SERIES);
    return { history: Object.fromEntries(retained), changes };
  }

  function summarizeSeries(series) {
    const samples = series?.samples || [];
    const prices = samples.map(sample => Number(sample.price)).filter(Number.isFinite);
    if (!prices.length) return { current: null, min: null, max: null, change: null };
    return {
      current: prices[prices.length - 1],
      min: Math.min(...prices),
      max: Math.max(...prices),
      change: prices[prices.length - 1] - prices[0]
    };
  }

  return {
    MAX_RANGE_DAYS,
    addDays,
    appendHistory,
    buildSearchUrl,
    dateRange,
    defaultSettings,
    flightIdentity,
    localIsoDate,
    normalizeSettings,
    summarizeSeries,
    validateSettings
  };
});
