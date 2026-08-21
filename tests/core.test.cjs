const assert = require("node:assert/strict");
const core = require("../extension/core.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("creates an inclusive three-day range", () => {
  assert.deepEqual(core.dateRange("2026-08-16", "2026-08-18"), [
    "2026-08-16", "2026-08-17", "2026-08-18"
  ]);
});

test("rejects a range longer than seven days", () => {
  assert.throws(
    () => core.dateRange("2026-08-16", "2026-08-23"),
    /最多 7 天/
  );
});

test("keeps the interval fixed at five minutes", () => {
  const settings = core.normalizeSettings({ intervalMinutes: 1 });
  assert.equal(settings.intervalMinutes, 5);
});

test("validates route and target price", () => {
  const input = core.defaultSettings(new Date("2026-08-12T10:00:00+08:00"));
  input.route.toCity = input.route.fromCity;
  input.route.toCode = input.route.fromCode;
  input.alerts.targetEnabled = true;
  input.alerts.targetPrice = 0;
  const result = core.validateSettings(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /不能相同/);
  assert.match(result.errors.join(" "), /心仪价格/);
});

test("builds a route-specific Qunar URL", () => {
  const settings = core.defaultSettings(new Date("2026-08-12T10:00:00+08:00"));
  const url = new URL(core.buildSearchUrl(settings, "2026-08-16"));
  assert.equal(url.hostname, "flight.qunar.com");
  assert.equal(url.searchParams.get("searchDepartureAirport"), "福州");
  assert.equal(url.searchParams.get("searchArrivalAirport"), "成都");
  assert.equal(url.searchParams.get("searchDepartureTime"), "2026-08-16");
  assert.equal(url.searchParams.get("searchArrivalTime"), "2026-08-17");
});

test("records first price, ignores a short unchanged sample, and detects a drop", () => {
  const flight = {
    airline: "海南航空",
    flightNo: "HU6226",
    flightNos: ["HU6226"],
    depart: "21:00",
    arrive: "00:05",
    direct: true,
    price: 760
  };
  const first = core.appendHistory({}, "2026-08-16", [flight], "2026-08-12T08:00:00.000Z");
  const id = core.flightIdentity("2026-08-16", flight);
  assert.equal(first.history[id].samples.length, 1);

  const unchanged = core.appendHistory(first.history, "2026-08-16", [flight], "2026-08-12T08:05:00.000Z");
  assert.equal(unchanged.history[id].samples.length, 1);

  const dropped = core.appendHistory(unchanged.history, "2026-08-16", [{ ...flight, price: 699 }], "2026-08-12T08:10:00.000Z");
  assert.equal(dropped.history[id].samples.length, 2);
  assert.deepEqual(dropped.changes.map(item => [item.previousPrice, item.price]), [[760, 699]]);
  assert.deepEqual(core.summarizeSeries(dropped.history[id]), {
    current: 699,
    min: 699,
    max: 760,
    change: -61
  });
});

for (const [name, fn] of tests) {
  fn();
  process.stdout.write(`✓ ${name}\n`);
}
process.stdout.write(`${tests.length} core tests passed\n`);
