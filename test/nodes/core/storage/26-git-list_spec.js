const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {execFileSync} = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const gitListNode = require("nr-test-utils").require("@node-red/nodes/core/storage/26-git-list.js");

describe("git list Node", function() {
    let root;
    let GitListNode;
    let settings;

    function send(node, message) {
        return new Promise(resolve => {
            let output;
            node.emit("input", message, result => { output = result; }, error => resolve({output, error}));
        });
    }

    beforeEach(function() {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-git-options-"));
        const repository = path.join(root, "example");
        fs.ensureDirSync(repository);
        function git(args) {
            execFileSync("git", args, {cwd: repository, stdio: "ignore"});
        }
        git(["init"]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
        git(["branch", "-M", "main"]);
        settings = {gitReposDirectory: root};
        gitListNode({
            settings,
            util: {
                evaluateNodeProperty(value, type, node, message) {
                    return type === "msg" ? value.split(".").reduce((result, key) => result && result[key], message) : value;
                }
            },
            nodes: {
                createNode(node) {
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                },
                registerType(name, constructor) {
                    assert.equal(name, "git list");
                    GitListNode = constructor;
                }
            }
        });
    });

    afterEach(function() {
        fs.removeSync(root);
    });

    it("lists repositories without changing the input payload", async function() {
        const payload = {prompt: "keep"};
        const result = await send(new GitListNode({mode: "repositories"}), {payload});
        assert.equal(result.error, undefined);
        assert.equal(result.output.payload, payload);
        assert.deepEqual(result.output.options, [{label: "example", value: "example"}]);
    });

    it("lists full Git references for the selected repository", async function() {
        const result = await send(new GitListNode({mode: "branches"}), {payload: {repository: "example"}});
        assert.equal(result.error, undefined);
        assert.deepEqual(result.output.options, [{label: "main", value: "refs/heads/main"}]);
    });

    it("prepares both lists for a Slack form in one message", async function() {
        const result = await send(new GitListNode({mode: "formData"}), {payload: "slash command text", slack: {command: "/agent"}});
        assert.equal(result.error, undefined);
        assert.deepEqual(result.output.payload.repositories, [{label: "example", value: "example"}]);
        assert.deepEqual(result.output.payload.branches.example, [{label: "main", value: "refs/heads/main"}]);
        assert.equal(result.output.slack.command, "/agent");
    });

    it("completes synchronously in every mode", function() {
        for (const mode of ["repositories", "branches", "formData"]) {
            const node = new GitListNode({mode});
            let output;
            let completed = false;
            node.emit("input", {payload: {repository: "example"}}, message => { output = message; }, error => {
                assert.equal(error, undefined);
                completed = true;
            });
            assert.equal(completed, true);
            assert.ok(output);
        }
    });

    it("never fetches missing remote branches in any mode", async function() {
        const repository = path.join(root, "example");
        const remote = path.join(root, "remote.git");
        execFileSync("git", ["init", "--bare", remote], {stdio: "ignore"});
        execFileSync("git", ["remote", "add", "origin", remote], {cwd: repository});

        for (const mode of ["repositories", "branches", "formData"]) {
            const branch = "new-" + mode;
            execFileSync("git", ["push", "origin", "HEAD:refs/heads/" + branch], {cwd: repository, stdio: "ignore"});
            const remoteRef = "refs/remotes/origin/" + branch;
            execFileSync("git", ["update-ref", "-d", remoteRef], {cwd: repository});

            const message = {payload: {repository: "example"}};
            const result = await send(new GitListNode({mode}), message);
            assert.equal(result.error, undefined);
            assert.throws(() => execFileSync("git", ["rev-parse", "--verify", remoteRef], {cwd: repository, stdio: "ignore"}));
            if (mode === "branches") {
                assert.equal(result.output.options.some(option => option.value === remoteRef), false);
            } else if (mode === "formData") {
                assert.equal(result.output.payload.branches.example.some(option => option.value === remoteRef), false);
            }
        }
    });

    it("returns cached remote branches even when the remote is unavailable", async function() {
        const repository = path.join(root, "example");
        execFileSync("git", ["remote", "add", "origin", path.join(root, "missing.git")], {cwd: repository});
        execFileSync("git", ["update-ref", "refs/remotes/origin/cached", "HEAD"], {cwd: repository});
        execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/cached"], {cwd: repository});
        const result = await send(new GitListNode({mode: "branches"}), {payload: {repository: "example"}});
        assert.equal(result.error, undefined);
        assert.deepEqual(result.output.options, [
            {label: "main", value: "refs/heads/main"},
            {label: "origin/cached", value: "refs/remotes/origin/cached"}
        ]);
    });

    it("accepts a configured directory that is itself a repository", async function() {
        settings.gitReposDirectory = path.join(root, "example");
        const result = await send(new GitListNode({mode: "formData"}), {});
        assert.equal(result.error, undefined);
        assert.deepEqual(result.output.payload.repositories, [{label: "example", value: "example"}]);
        const invalid = await send(new GitListNode({mode: "branches"}), {payload: {repository: "other"}});
        assert.match(invalid.error.message, /not configured/);
    });

    it("ignores non-repositories and rejects symbolic repository directories", async function() {
        fs.ensureDirSync(path.join(root, "not-a-repo"));
        fs.symlinkSync(path.join(root, "example"), path.join(root, "linked"), "dir");
        const repositories = await send(new GitListNode({mode: "repositories"}), {});
        assert.deepEqual(repositories.output.options, [{label: "example", value: "example"}]);
        const linked = await send(new GitListNode({mode: "branches"}), {payload: {repository: "linked"}});
        assert.equal(linked.output, undefined);
        assert.match(linked.error.message, /not a directory/);
    });

    it("rejects a missing or relative repository root", async function() {
        for (const directory of ["relative", path.join(root, "missing")]) {
            settings.gitReposDirectory = directory;
            const result = await send(new GitListNode({mode: "repositories"}), {});
            assert.equal(result.output, undefined);
            assert.ok(result.error);
        }
    });

    it("rejects unknown repositories without exposing other paths", async function() {
        const result = await send(new GitListNode({mode: "branches"}), {payload: {repository: "../other"}});
        assert.equal(result.output, undefined);
        assert.match(result.error.message, /Invalid repository name/);
    });
});
