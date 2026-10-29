const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const source = process.env.LUMINE_RESOURCE_PATH || path.resolve(packageRoot, "..", "lumine");
const electron = require(path.join(source, "node_modules", "electron"));
const home = path.join(packageRoot, ".dev", "test-home");
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  LUMINE_HOME: home,
  LUMINE_RESOURCE_PATH: source,
  LUMINE_JASMINE_REPORTER: "list",
};
delete env.CI;
delete env.ELECTRON_RUN_AS_NODE;
const targets = process.argv.slice(2);
const child = spawn(
  electron,
  [
    "--no-sandbox",
    "--enable-logging",
    source,
    "-f",
    "--dev",
    "--test",
    ...(targets.length
      ? targets.map((target) => path.resolve(target))
      : [path.join(packageRoot, "spec")]),
  ],
  {
    cwd: source,
    windowsHide: true,
    env,
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
