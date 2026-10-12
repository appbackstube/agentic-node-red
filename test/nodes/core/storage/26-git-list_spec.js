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
        gitListNode({
            settings: {gitReposDirectory: root},
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

    it("rejects unknown repositories without exposing other paths", async function() {
        const result = await send(new GitListNode({mode: "branches"}), {payload: {repository: "../other"}});
        assert.equal(result.output, undefined);
        assert.match(result.error.message, /Invalid repository name/);
    });
});
