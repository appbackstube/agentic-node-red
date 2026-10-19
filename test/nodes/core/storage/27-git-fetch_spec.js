const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {execFileSync} = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const gitFetchNode = require("nr-test-utils").require("@node-red/nodes/core/storage/27-git-fetch.js");
const gitListNode = require("nr-test-utils").require("@node-red/nodes/core/storage/26-git-list.js");

describe("git fetch Node", function() {
    let root;
    let repository;
    let remote;
    let settings;
    let statuses;
    let constructors;

    function git(args, directory = repository) {
        return execFileSync("git", args, {cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
    }

    function send(node, message) {
        return new Promise(resolve => {
            let output;
            node.emit("input", message, result => { output = result; }, error => resolve({output, error}));
        });
    }

    function publishBranch(name) {
        git(["push", "origin", "HEAD:refs/heads/" + name]);
        git(["update-ref", "-d", "refs/remotes/origin/" + name]);
    }

    beforeEach(function() {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-git-fetch-"));
        repository = path.join(root, "example");
        remote = path.join(root, "remote.git");
        fs.ensureDirSync(repository);
        git(["init"]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
        git(["branch", "-M", "main"]);
        git(["init", "--bare", remote]);
        git(["remote", "add", "origin", remote]);
        git(["push", "origin", "main"]);
        settings = {gitReposDirectory: root};
        statuses = [];
        constructors = {};
        const RED = {
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
                    node.status = status => statuses.push(status);
                },
                registerType(name, constructor) {
                    constructors[name] = constructor;
                }
            }
        };
        gitFetchNode(RED);
        gitListNode(RED);
    });

    afterEach(function() {
        fs.removeSync(root);
    });

    it("fetches all repositories asynchronously and preserves the original message", async function() {
        const second = path.join(root, "second");
        git(["clone", remote, second]);
        publishBranch("new-branch");
        const node = new constructors["git fetch"]({mode: "all"});
        const message = {payload: {keep: true}, slack: {interactionId: "unchanged"}};
        let completed = false;
        const pending = send(node, message).then(result => {
            completed = true;
            return result;
        });
        assert.equal(completed, false);
        const result = await pending;
        assert.equal(result.error, undefined);
        assert.equal(result.output, message);
        assert.equal(git(["rev-parse", "refs/remotes/origin/new-branch"]), git(["rev-parse", "HEAD"]));
        assert.equal(git(["rev-parse", "refs/remotes/origin/new-branch"], second), git(["rev-parse", "HEAD"]));
        assert.deepEqual(statuses.at(-1), {});
    });

    it("fetches only the repository selected from a message property", async function() {
        const second = path.join(root, "second");
        git(["clone", remote, second]);
        publishBranch("selected-only");
        const message = {selected: "example", payload: "keep"};
        const result = await send(new constructors["git fetch"]({mode: "repository", repository: "selected", repositoryType: "msg"}), message);
        assert.equal(result.error, undefined);
        assert.equal(result.output, message);
        assert.equal(git(["rev-parse", "refs/remotes/origin/selected-only"]), git(["rev-parse", "HEAD"]));
        assert.throws(() => git(["rev-parse", "--verify", "refs/remotes/origin/selected-only"], second));
    });

    it("accepts a configured repository name and does not change working files or the current branch", async function() {
        publishBranch("feature");
        fs.writeFileSync(path.join(repository, "keep.txt"), "unchanged");
        const result = await send(new constructors["git fetch"]({mode: "repository", repository: "example", repositoryType: "str"}), {});
        assert.equal(result.error, undefined);
        assert.equal(git(["branch", "--show-current"]), "main");
        assert.equal(fs.readFileSync(path.join(repository, "keep.txt"), "utf8"), "unchanged");
    });

    it("prunes removed remote references", async function() {
        const head = git(["rev-parse", "HEAD"]);
        git(["update-ref", "refs/remotes/origin/removed", head]);
        const result = await send(new constructors["git fetch"]({}), {});
        assert.equal(result.error, undefined);
        assert.throws(() => git(["rev-parse", "--verify", "refs/remotes/origin/removed"]));
    });

    it("makes newly fetched branches available to a separate Git List node", async function() {
        publishBranch("fresh");
        const list = new constructors["git list"]({mode: "formData"});
        const before = await send(list, {});
        assert.equal(before.output.payload.branches.example.some(option => option.value === "refs/remotes/origin/fresh"), false);
        const fetched = await send(new constructors["git fetch"]({mode: "all"}), {});
        assert.equal(fetched.error, undefined);
        const after = await send(list, {});
        assert.equal(after.output.payload.branches.example.some(option => option.value === "refs/remotes/origin/fresh"), true);
    });

    it("stops the message when a remote cannot be fetched", async function() {
        git(["remote", "set-url", "origin", path.join(root, "missing.git")]);
        const result = await send(new constructors["git fetch"]({mode: "all"}), {payload: "keep"});
        assert.equal(result.output, undefined);
        assert.ok(result.error);
        assert.equal(statuses.at(-1).text, "Git fetch failed");
    });

    it("rejects traversal and invalid modes without forwarding a message", async function() {
        const invalid = await send(new constructors["git fetch"]({mode: "repository"}), {payload: {repository: "../other"}});
        assert.equal(invalid.output, undefined);
        assert.match(invalid.error.message, /Invalid repository name/);
        const unsupported = await send(new constructors["git fetch"]({mode: "unknown"}), {});
        assert.equal(unsupported.output, undefined);
        assert.match(unsupported.error.message, /Unsupported Git fetch mode/);
    });

    it("supports a root that is itself a repository", async function() {
        settings.gitReposDirectory = repository;
        publishBranch("single-root");
        const result = await send(new constructors["git fetch"]({mode: "all"}), {});
        assert.equal(result.error, undefined);
        assert.equal(git(["rev-parse", "refs/remotes/origin/single-root"]), git(["rev-parse", "HEAD"]));
    });
});
