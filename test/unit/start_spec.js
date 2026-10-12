const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const should = require("should");
const localSettingsArgs = require("../../scripts/start");

describe("repository-local settings selection", function() {
    let root;

    beforeEach(function() {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-settings-"));
    });

    afterEach(function() {
        fs.removeSync(root);
    });

    it("loads the repository-local settings file when available", function() {
        const file = path.join(root, "settings.js");
        fs.writeFileSync(file, "module.exports = {};");
        localSettingsArgs([], root).should.deepEqual(["--settings", file]);
    });

    it("retains Node-RED defaults without a local file", function() {
        localSettingsArgs([], root).should.deepEqual([]);
    });

    it("keeps explicit settings and user directories", function() {
        fs.writeFileSync(path.join(root, "settings.js"), "module.exports = {};");
        localSettingsArgs(["--settings", "/custom/settings.js"], root).should.deepEqual([]);
        localSettingsArgs(["--settings=/custom/settings.js"], root).should.deepEqual([]);
        localSettingsArgs(["-s", "/custom/settings.js"], root).should.deepEqual([]);
        localSettingsArgs(["--userDir", "/custom"], root).should.deepEqual([]);
        localSettingsArgs(["-u", "/custom"], root).should.deepEqual([]);
    });
});
