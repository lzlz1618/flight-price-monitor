const assert = require("node:assert/strict");
const parser = require("../extension/parser.js");

const directText = `
海南航空
HU6226 空客320
21:00 长乐机场
00:05 天府机场T2
¥760
经济舱 1.6折
`;

const transferText = `
东方航空
MU5532 MU9187
06:35 长乐机场
转上海 停留5小时35分
16:40 天府机场T2
¥700
`;

const direct = parser.parseFlightText(directText, true);
assert.deepEqual(direct, {
  airline: "海南航空",
  flightNo: "HU6226",
  flightNos: ["HU6226"],
  depart: "21:00",
  arrive: "00:05",
  price: 760,
  direct: true
});

assert.equal(parser.parseFlightText(transferText, true), null);
const transfer = parser.parseFlightText(transferText, false);
assert.equal(transfer.direct, false);
assert.equal(transfer.flightNo, "MU5532+MU9187");
assert.equal(transfer.price, 700);

assert.deepEqual(parser.pricesFromText("票价 ￥699，折扣 1.8，原价 ¥1200"), [699, 1200]);
assert.deepEqual(parser.timesFrom("06:35 出发 12:45 到达"), ["06:35", "12:45"]);
assert.equal(parser.pageProblem({ body: { innerText: "访问异常，请完成滑块验证" } }), "去哪儿要求安全验证，请打开对应监控页面并手动完成验证。");

const promotionText = `
海南航空
HU6226
21:00 长乐机场
00:05 天府机场
¥760
最高立减 ¥100
`;
assert.equal(parser.primaryPriceFromText(promotionText), 760);
assert.equal(parser.parseFlightText(promotionText, true).price, 760);
assert.equal(parser.priceFromElement({
  className: "flight-price",
  id: "",
  innerText: "¥699起",
  getAttribute: () => null,
  parentElement: null
}), 699);
assert.equal(parser.priceConfidence({
  className: "coupon-price",
  id: "",
  getAttribute: () => null,
  parentElement: null
}), -1);

process.stdout.write("10 parser tests passed\n");
