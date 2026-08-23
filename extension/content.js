(() => {
  if (globalThis.__FLIGHT_PRICE_MONITOR_INSTALLED__) return;
  globalThis.__FLIGHT_PRICE_MONITOR_INSTALLED__ = true;

  const parser = globalThis.FlightPageParser;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let activeRun = null;

  async function report(payload, options) {
    try {
      await chrome.runtime.sendMessage({
        type: "flightResult",
        date: options.date,
        requestId: options.requestId || null,
        settingsRevision: options.settingsRevision || 0,
        ...payload
      });
    } catch {}
  }

  async function ensureDirectFilter(directOnly) {
    if (!directOnly) return false;
    const control = parser.findDirectControl(document);
    if (!control || parser.controlChecked(control)) return false;
    control.click();
    await sleep(1800);
    return true;
  }

  async function collect(options) {
    const initialProblem = parser.pageProblem(document);
    if (initialProblem) {
      await report({ error: initialProblem, userActionRequired: true }, options);
      return;
    }

    const filterChanged = await ensureDirectFilter(options.directOnly);
    if (options.refresh && !filterChanged) {
      const searchButton = parser.findSearchButton(document);
      if (searchButton && !searchButton.disabled) {
        searchButton.click();
        await sleep(1200);
      }
    }

    let previousSignature = "";
    let stableReads = 0;
    for (let attempt = 0; attempt < 85; attempt += 1) {
      await sleep(1000);
      const problem = parser.pageProblem(document);
      if (problem) {
        await report({ error: problem, userActionRequired: /验证/.test(problem) }, options);
        return;
      }

      const flights = parser.extractFlights(document, options.directOnly);
      if (flights.length) {
        const signature = JSON.stringify(flights.map(flight => [flight.flightNo, flight.depart, flight.arrive, flight.price]));
        stableReads = signature === previousSignature ? stableReads + 1 : 1;
        previousSignature = signature;
        if ((stableReads >= 3 && attempt >= 4) || attempt >= 15) {
          await report({ flights }, options);
          return;
        }
      }

      const bodyText = document.body?.innerText || "";
      if (attempt >= 12 && /暂无.*航班|没有找到.*航班|无符合条件/.test(bodyText)) {
        await report({ error: "页面暂时没有返回符合条件的航班，扩展稍后会自动重试。" }, options);
        return;
      }
    }
    await report({ error: "页面已打开，但没有识别到航班价格；连续失败后将自动恢复页面。" }, options);
  }

  function start(options) {
    if (activeRun) return activeRun;
    activeRun = collect(options)
      .catch(error => report({ error: `检查异常：${error.message}` }, options))
      .finally(() => { activeRun = null; });
    return activeRun;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "runFlightCheck") return false;
    start({
      date: message.date,
      requestId: message.requestId,
      settingsRevision: message.settingsRevision || 0,
      directOnly: Boolean(message.directOnly),
      refresh: Boolean(message.refresh)
    });
    sendResponse({ accepted: true });
    return false;
  });
})();
