const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {execFileSync} = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const gitRepoNode = require("nr-test-utils").require("@node-red/nodes/core/storage/25-git-repo.js");

describe("git repo checkout without an HTTP server", function() {
    let root;
    let repository;
    let GitRepoNode;

    function git(args) {
        return execFileSync("git", args, {cwd: repository, encoding: "utf8"}).trim();
    }

    function send(node, payload) {
        return new Promise(function(resolve) {
            let output;
            node.emit("input", {payload}, msg => { output = msg; }, error => resolve({output, error}));
        });
    }

    beforeEach(function() {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-git-switch-"));
        repository = path.join(root, "example");
        fs.ensureDirSync(repository);
        git(["init"]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
        git(["branch", "-M", "main"]);
        git(["branch", "feature"]);
        git(["remote", "add", "origin", repository]);
        git(["update-ref", "refs/remotes/origin/remote-feature", "HEAD"]);
        gitRepoNode({
            settings: {gitReposDirectory: root},
            auth: {needsPermission: () => () => {}},
            httpAdmin: {get: () => {}},
            nodes: {
                createNode(node) {
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                },
                registerType(name, constructor) {
                    assert.equal(name, "git repo");
                    GitRepoNode = constructor;
                }
            }
        });
    });

    afterEach(function() {
        fs.removeSync(root);
    });

    it("checks out the branch from the payload", async function() {
        const payload = {repository: "example", branch: "feature", prompt: "Review"};
        const result = await send(new GitRepoNode({}), payload);
        assert.equal(result.error, undefined);
        assert.equal(result.output.payload, payload);
        assert.equal(result.output.git.ref, "refs/heads/feature");
        assert.equal(git(["branch", "--show-current"]), "feature");
    });

    it("creates and reuses a local tracking branch without losing dirty files", async function() {
        const node = new GitRepoNode({});
        const payload = {repository: "example", branch: "origin/remote-feature"};
        const first = await send(node, payload);
        assert.equal(first.error, undefined);
        assert.equal(first.output.git.ref, "refs/heads/remote-feature");
        assert.equal(git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]), "origin/remote-feature");
        fs.writeFileSync(path.join(repository, "untracked.txt"), "keep");
        const second = await send(node, payload);
        assert.equal(second.error, undefined);
        assert.equal(second.output.git.branch, "remote-feature");
        assert.equal(fs.readFileSync(path.join(repository, "untracked.txt"), "utf8"), "keep");
    });

    it("optionally fetches and fast-forwards a remote tracking branch", async function() {
        const remote = path.join(root, "remote.git");
        execFileSync("git", ["init", "--bare", remote]);
        git(["remote", "set-url", "origin", remote]);
        git(["push", "origin", "HEAD:refs/heads/release/6.7.2"]);
        const oldHead = git(["rev-parse", "HEAD"]);
        const payload = {repository: "example", branch: "refs/remotes/origin/release/6.7.2"};

        const first = await send(new GitRepoNode({}), payload);
        assert.equal(first.error, undefined);
        assert.equal(first.output.git.ref, "refs/heads/release/6.7.2");
        assert.equal(git(["rev-parse", "HEAD"]), oldHead);

        const newHead = git(["-c", "user.name=Test", "-c", "user.email=test@example.com",
            "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "New remote commit"]);
        git(["push", "origin", newHead + ":refs/heads/release/6.7.2"]);
        git(["update-ref", "refs/remotes/origin/release/6.7.2", oldHead]);

        const unchanged = await send(new GitRepoNode({}), payload);
        assert.equal(unchanged.error, undefined);
        assert.equal(git(["rev-parse", "HEAD"]), oldHead);

        const fetched = await send(new GitRepoNode({fetchRemote: true}), payload);
        assert.equal(fetched.error, undefined);
        assert.equal(git(["rev-parse", "refs/remotes/origin/release/6.7.2"]), newHead);
        assert.equal(git(["rev-parse", "HEAD"]), oldHead);

        fs.writeFileSync(path.join(repository, "untracked.txt"), "keep");
        const dirty = await send(new GitRepoNode({pullLatest: true}), payload);
        assert.match(dirty.error.message, /uncommitted changes/);
        assert.equal(git(["rev-parse", "HEAD"]), oldHead);
        assert.equal(fs.readFileSync(path.join(repository, "untracked.txt"), "utf8"), "keep");
        fs.removeSync(path.join(repository, "untracked.txt"));

        const updated = await send(new GitRepoNode({pullLatest: true}), payload);
        assert.equal(updated.error, undefined);
        assert.equal(updated.output.git.branch, "release/6.7.2");
        assert.equal(git(["rev-parse", "HEAD"]), newHead);
    });

    it("does not pull a local branch without an upstream", async function() {
        const result = await send(new GitRepoNode({pullLatest: true}), {repository: "example", branch: "feature"});
        assert.match(result.error.message, /no upstream/);
        assert.equal(result.output, undefined);
        assert.equal(git(["branch", "--show-current"]), "main");
    });

    it("does not switch branches when the working tree is dirty", async function() {
        fs.writeFileSync(path.join(repository, "untracked.txt"), "keep");
        const result = await send(new GitRepoNode({}), {repository: "example", branch: "feature"});
        assert.match(result.error.message, /uncommitted changes/);
        assert.equal(result.output, undefined);
        assert.equal(git(["branch", "--show-current"]), "main");
    });
});
