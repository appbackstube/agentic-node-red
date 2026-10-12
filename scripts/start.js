const fs = require("fs");
const path = require("path");

function localSettingsArgs(args, root = path.resolve(__dirname, "..")) {
    if (args.some(arg => arg === "--settings" || arg === "-s" || arg.startsWith("--settings=") ||
            arg === "--userDir" || arg === "-u" || arg.startsWith("--userDir="))) {
        return [];
    }
    const file = path.join(root, "settings.js");
    return fs.existsSync(file) ? ["--settings", file] : [];
}

if (require.main === module) {
    process.argv.splice(2, 0, ...localSettingsArgs(process.argv.slice(2)));
    require("../packages/node_modules/node-red/red.js");
}

module.exports = localSettingsArgs;
