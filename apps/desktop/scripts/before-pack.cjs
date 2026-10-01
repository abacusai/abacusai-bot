const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = () => {
  execFileSync(
    process.execPath,
    [path.join(__dirname, "check-release-build.mjs")],
    { stdio: "inherit" }
  );
  execFileSync(
    process.execPath,
    [path.join(__dirname, "generate-notices.js")],
    {
      stdio: "inherit",
    }
  );
};
