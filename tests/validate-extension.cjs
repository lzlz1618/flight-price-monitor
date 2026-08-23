const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.options_page, "dashboard.html");
assert.equal(manifest.content_scripts.length, 1);

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap(item => item.js)
];
for (const file of referenced) {
  assert.ok(fs.existsSync(path.join(extension, file)), `manifest file is missing: ${file}`);
}

const jsFiles = fs.readdirSync(extension).filter(file => file.endsWith(".js"));
for (const file of jsFiles) {
  childProcess.execFileSync(process.execPath, ["--check", path.join(extension, file)], { stdio: "pipe" });
}

const source = jsFiles.map(file => fs.readFileSync(path.join(extension, file), "utf8")).join("\n");
assert.doesNotMatch(
  source,
  /pushPlusToken\s*[:=]\s*["'][0-9a-f]{32}["']/i,
  "a personal PushPlus token was committed"
);
assert.doesNotMatch(source, /<script[^>]+src=["']https?:/i, "remote scripts are not allowed in Manifest V3");
const backgroundSource = fs.readFileSync(path.join(extension, "background.js"), "utf8");
assert.match(backgroundSource, /releaseMonitorTab/, "temporary monitor tabs must be released");
assert.match(backgroundSource, /chrome\.tabs\.remove/, "temporary monitor tabs must be closed");

process.stdout.write(`${jsFiles.length} extension scripts passed syntax and privacy validation\n`);
