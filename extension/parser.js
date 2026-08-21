(function initializeParser(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FlightPageParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TIME_PATTERN = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
  const PRICE_PATTERN = /[¥￥]\s*([1-9]\d{2,4})(?!\d)/g;
  const FLIGHT_PATTERN = /\b[A-Z0-9]{2}\s?\d{3,4}\b/g;
  const TRANSFER_PATTERN = /中转|经停|停留\s*\d|转\s*[\u4e00-\u9fa5]{1,8}/;

  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const unique = values => [...new Set(values)];

  function timesFrom(text) {
    return [...normalize(text).matchAll(TIME_PATTERN)].map(match => match[0]);
  }

  function pricesFromText(text) {
    return [...String(text || "").matchAll(PRICE_PATTERN)]
      .map(match => Number(match[1]))
      .filter(price => price >= 100 && price <= 50000);
  }

  function flightNumbersFrom(text) {
    return unique([...normalize(text).matchAll(FLIGHT_PATTERN)].map(match => match[0].replace(/\s+/g, "")));
  }

  function isTransferText(text) {
    return TRANSFER_PATTERN.test(normalize(text));
  }

  function airlineFromText(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(normalize)
      .find(line => /航空$|航空公司$|国航$|春秋$/.test(line)) || "未知航司";
  }

  function parseFlightText(text, directOnly = false) {
    const times = timesFrom(text);
    const prices = pricesFromText(text);
    const flightNos = flightNumbersFrom(text);
    if (times.length < 2 || !prices.length || !flightNos.length) return null;
    const direct = !isTransferText(text);
    if (directOnly && !direct) return null;
    return {
      airline: airlineFromText(text),
      flightNo: flightNos.join("+"),
      flightNos,
      depart: times[0],
      arrive: times[times.length - 1],
      price: Math.min(...prices),
      direct
    };
  }

  function visible(element) {
    if (!element || typeof Element === "undefined" || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function nearestFlightCard(node, directOnly) {
    let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    for (let depth = 0; element && depth < 16; depth += 1, element = element.parentElement) {
      if (!visible(element)) continue;
      const text = element.innerText || "";
      if (text.length < 20 || text.length > 5000) continue;
      if (parseFlightText(text, directOnly)) return element;
    }
    return null;
  }

  function priceAnchors(doc) {
    const anchors = [];
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (/[¥￥]\s*[1-9]\d{2}/.test(walker.currentNode.nodeValue || "")) {
        anchors.push(walker.currentNode.parentElement);
      }
    }
    for (const element of doc.querySelectorAll("[data-price],[data-amount],[class*='price'],[class*='prc']")) {
      anchors.push(element);
    }
    return unique(anchors.filter(Boolean));
  }

  function extractFlights(doc = document, directOnly = false) {
    const cards = new Set();
    for (const anchor of priceAnchors(doc)) {
      const card = nearestFlightCard(anchor, directOnly);
      if (card) cards.add(card);
    }
    const output = [];
    const seen = new Set();
    for (const card of cards) {
      const flight = parseFlightText(card.innerText || "", directOnly);
      if (!flight) continue;
      const imageAirline = [...card.querySelectorAll("img[alt]")]
        .map(image => normalize(image.alt))
        .find(value => /航空|国航|春秋/.test(value));
      if (imageAirline) flight.airline = imageAirline;
      const key = `${flight.flightNo}|${flight.depart}|${flight.arrive}|${flight.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(flight);
    }
    return output.sort((a, b) => a.price - b.price);
  }

  function textOf(element) {
    return normalize(element?.value || element?.innerText || element?.textContent || element?.getAttribute?.("aria-label"));
  }

  function findDirectControl(doc = document) {
    for (const checkbox of doc.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) {
      const labelled = [checkbox.getAttribute("aria-label"), checkbox.closest("label")?.innerText, checkbox.parentElement?.innerText]
        .map(normalize).join(" ");
      if (labelled.includes("直飞")) return checkbox;
    }
    const label = [...doc.querySelectorAll("label,button,span,div")]
      .find(element => visible(element) && textOf(element) === "直飞");
    return label?.closest("label,button,[role='checkbox']") || label?.parentElement || null;
  }

  function controlChecked(control) {
    if (!control) return false;
    if ("checked" in control) return Boolean(control.checked);
    if (control.getAttribute("aria-checked") === "true") return true;
    return /checked|selected|active|current|on/i.test(String(control.className || ""));
  }

  function findSearchButton(doc = document) {
    return [...doc.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]')]
      .find(element => visible(element) && /^(搜\s*索|搜索航班)$/.test(textOf(element))) || null;
  }

  function pageProblem(doc = document) {
    const text = normalize(doc.body?.innerText).slice(0, 8000);
    if (/请输入验证码|访问异常|操作频繁|安全验证|滑块验证|完成验证/.test(text)) {
      return "去哪儿要求安全验证，请打开对应监控页面并手动完成验证。";
    }
    if (/网络异常|请求失败|加载失败|请稍后再试/.test(text)) {
      return "去哪儿页面网络异常，扩展稍后会自动重试。";
    }
    return "";
  }

  return {
    controlChecked,
    extractFlights,
    findDirectControl,
    findSearchButton,
    flightNumbersFrom,
    isTransferText,
    pageProblem,
    parseFlightText,
    pricesFromText,
    timesFrom
  };
});
