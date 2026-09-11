const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = () => {
  execFileSync(
    process.execPath,
    [path.join(__dirname, "generate-notices.js")],
    {
      stdio: "inherit",
    }
  );
};
