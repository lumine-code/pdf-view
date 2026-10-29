const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const workspace = path.dirname(root);
const source = process.env.LUMINE_RESOURCE_PATH || path.join(workspace, "lumine");
const home = path.join(root, ".dev", "preview-home");
const packages = path.join(home, "packages");
fs.mkdirSync(packages, { recursive: true });
for (const name of [
  "pdf-view",
  "image-editor",
  "tree-view",
  "navigation-panel",
  "search-panel",
  "invert-colors",
  "scrollmap",
  "marker",
  "breadcrumbs",
  "language-regex",
  "latex-tools",
  "typst-tools",
]) {
  const target = path.join(packages, name);
  if (!fs.existsSync(target))
    fs.symlinkSync(
      path.join(workspace, name),
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
}
const config = path.join(home, "config.json");
if (!fs.existsSync(config))
  fs.writeFileSync(
    config,
    JSON.stringify({ "*": { core: { disabledPackages: ["welcome"] } } }, null, 2),
  );
const env = {
  ...process.env,
  LUMINE_HOME: home,
  LUMINE_RESOURCE_PATH: source,
  LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE: "1",
  LUMINE_DISABLE_URI_HANDLER_REGISTRATION: "1",
};
delete env.CI;
delete env.ELECTRON_RUN_AS_NODE;
const port = Number(process.env.PDF_VIEW_PREVIEW_PORT || 0);
if (port && (!Number.isInteger(port) || port < 1024 || port > 65535))
  throw new Error("PDF_VIEW_PREVIEW_PORT must be a port between 1024 and 65535");
const log = fs.openSync(path.join(home, "preview.log"), "a");
const child = spawn(
  require(path.join(source, "node_modules", "electron")),
  [
    "--no-sandbox",
    ...(port ? [`--remote-debugging-port=${port}`] : []),
    source,
    "-f",
    "--dev",
    ...process.argv.slice(2).map((file) => path.resolve(file)),
  ],
  { cwd: root, windowsHide: true, env, stdio: ["ignore", log, log], detached: true },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.unref();
fs.closeSync(log);
fs.writeFileSync(path.join(home, "preview.pid"), String(child.pid));
console.log("PDF View preview launched with an isolated local profile.");
