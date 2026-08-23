(function initializeParser(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FlightPageParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TIME_PATTERN = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
  const PRICE_PATTERN = /[¥￥]\s*([1-9]\d{2,4})(?!\d)/g;
  const FLIGHT_PATTERN = /\b[A-Z0-9]{2}\s?\d{3,4}\b/g;
  const TRANSFER_PATTERN = /中转|经停|停留\s*\d|转\s*[\u4e00-\u9fa5]{1,8}/;
  const PROMOTION_PATTERN = /最高.*(?:减|省)|(?:立减|返现|返券|优惠券|红包|补贴|立省|可减|再减)/;
  const PROMOTION_CLASS_PATTERN = /coupon|discount|promo|subsidy|rebate|save|benefit|red.?packet/i;
  const PRICE_CLASS_PATTERN = /(?:^|[-_\s])(price|prc|fare|amount)(?:$|[-_\s])/i;

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

  function primaryPriceFromText(text) {
    const candidates = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = normalize(rawLine);
      if (!line || PROMOTION_PATTERN.test(line)) continue;
      candidates.push(...pricesFromText(line));
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  function priceFromElement(element) {
    if (!element) return null;
    for (const attribute of ["data-price", "data-amount"]) {
      const value = Number(String(element.getAttribute?.(attribute) || "").replace(/[^\d.]/g, ""));
      if (Number.isFinite(value) && value >= 100 && value <= 50000) return Math.round(value);
    }
    const text = String(element.innerText || element.textContent || "").trim();
    if (!text || text.length > 100 || PROMOTION_PATTERN.test(normalize(text))) return null;
    return primaryPriceFromText(text);
  }

  function priceConfidence(element) {
    if (!element) return -1;
    const descriptor = `${element.className || ""} ${element.id || ""}`;
    const parentDescriptor = `${element.parentElement?.className || ""} ${element.parentElement?.id || ""}`;
    if (PROMOTION_CLASS_PATTERN.test(descriptor) || PROMOTION_CLASS_PATTERN.test(parentDescriptor)) return -1;
    if (element.getAttribute?.("data-price") || element.getAttribute?.("data-amount")) return 3;
    if (PRICE_CLASS_PATTERN.test(descriptor)) return 2;
    if (PRICE_CLASS_PATTERN.test(parentDescriptor)) return 1;
    return 0;
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

  function parseFlightText(text, directOnly = false, priceOverride = null) {
    const times = timesFrom(text);
    const flightNos = flightNumbersFrom(text);
    const parsedPrice = Number(priceOverride);
    const price = Number.isFinite(parsedPrice) && parsedPrice >= 100
      ? parsedPrice
      : primaryPriceFromText(text);
    if (times.length < 2 || !Number.isFinite(price) || !flightNos.length) return null;
    const direct = !isTransferText(text);
    if (directOnly && !direct) return null;
    return {
      airline: airlineFromText(text),
      flightNo: flightNos.join("+"),
      flightNos,
      depart: times[0],
      arrive: times[times.length - 1],
      price,
      direct
    };
  }

  function visible(element) {
    if (!element || typeof Element === "undefined" || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function nearestFlightCard(node, directOnly, price) {
    let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    for (let depth = 0; element && depth < 16; depth += 1, element = element.parentElement) {
      if (!visible(element)) continue;
      const text = element.innerText || "";
      if (text.length < 20 || text.length > 5000) continue;
      const times = timesFrom(text);
      const flightNos = flightNumbersFrom(text);
      if (times.length > 6 || flightNos.length > 4) continue;
      if (parseFlightText(text, directOnly, price)) return element;
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
    const flightsByIdentity = new Map();
    for (const anchor of priceAnchors(doc)) {
      const price = priceFromElement(anchor);
      if (!Number.isFinite(price)) continue;
      const confidence = priceConfidence(anchor);
      if (confidence < 0) continue;
      const card = nearestFlightCard(anchor, directOnly, price);
      if (!card) continue;
      const flight = parseFlightText(card.innerText || "", directOnly, price);
      if (!flight) continue;
      const imageAirline = [...card.querySelectorAll("img[alt]")]
        .map(image => normalize(image.alt))
        .find(value => /航空|国航|春秋/.test(value));
      if (imageAirline) flight.airline = imageAirline;
      const key = `${flight.flightNo}|${flight.depart}|${flight.arrive}`;
      const existing = flightsByIdentity.get(key);
      if (!existing || confidence > existing.confidence
        || (confidence === existing.confidence && flight.price < existing.flight.price)) {
        flightsByIdentity.set(key, { flight, confidence });
      }
    }
    return [...flightsByIdentity.values()].map(item => item.flight).sort((a, b) => a.price - b.price);
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
    priceConfidence,
    priceFromElement,
    primaryPriceFromText,
    pricesFromText,
    timesFrom
  };
});
