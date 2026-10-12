const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const {execFileSync} = require("child_process");
const should = require("should");
const helper = require("node-red-node-test-helper");
const gitRepoNode = require("nr-test-utils").require("@node-red/nodes/core/storage/25-git-repo.js");

describe("git repo Node", function() {
    let root;
    let repositoryPath;

    function git(directory, args) {
        return execFileSync("git", args, {cwd: directory, encoding: "utf8"}).trim();
    }

    function createRepository(name) {
        const directory = path.join(root, name);
        fs.ensureDirSync(directory);
        git(directory, ["init"]);
        git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
        git(directory, ["branch", "-M", "main"]);
        return directory;
    }

    function receiveMessage(node, receiver, message) {
        return new Promise(function(resolve, reject) {
            function cleanup() {
                node.removeListener("call:status", onStatus);
                receiver.removeListener("input", onInput);
            }
            function onStatus(call) {
                if (call.args[0].fill === "red") {
                    cleanup();
                    reject(new Error(call.args[0].text));
                }
            }
            function onInput(output) {
                cleanup();
                resolve(output);
            }
            node.on("call:status", onStatus);
            receiver.on("input", onInput);
            node.receive(message);
        });
    }

    beforeEach(async function() {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-git-repo-"));
        repositoryPath = createRepository("example");
        git(repositoryPath, ["branch", "feature"]);
        git(repositoryPath, ["remote", "add", "origin", repositoryPath]);
        git(repositoryPath, ["update-ref", "refs/remotes/origin/remote-feature", "HEAD"]);
        git(repositoryPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/remote-feature"]);
        helper.settings({gitReposDirectory: root});
        await helper.startServer();
    });

    afterEach(async function() {
        await helper.unload();
        await helper.stopServer();
        fs.removeSync(root);
    });

    it("lists only direct Git repositories", async function() {
        fs.ensureDirSync(path.join(root, "not-a-repo"));
        fs.ensureDirSync(path.join(root, "nested"));
        createRepository(path.join("nested", "deeper"));
        if (process.platform !== "win32") {
            fs.symlinkSync(repositoryPath, path.join(root, "linked"), "dir");
        }
        await helper.load(gitRepoNode, []);

        const response = await helper.request().get("/git-repos").expect(200);
        response.body.should.deepEqual(["example"]);
    });

    it("accepts a configured directory that is itself a Git repository", async function() {
        helper.settings({gitReposDirectory: repositoryPath});
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", repository: "example", branch: "refs/heads/main", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);

        const repositories = await helper.request().get("/git-repos").expect(200);
        repositories.body.should.deepEqual(["example"]);
        const branches = await helper.request().get("/git-repos/example/branches").expect(200);
        branches.body.some(branch => branch.ref === "refs/heads/main").should.be.true();
        await helper.request().get("/git-repos/other/branches").expect(404);

        const message = await new Promise(function(resolve) {
            helper.getNode("receiver").once("input", resolve);
            helper.getNode("repo").receive({payload: "unchanged"});
        });
        message.git.path.should.equal(fs.realpathSync(repositoryPath));
        message.payload.should.equal("unchanged");
    });

    it("lists local and cached remote branches without the symbolic remote HEAD", async function() {
        await helper.load(gitRepoNode, []);

        const response = await helper.request().get("/git-repos/example/branches").expect(200);
        response.body.should.containDeep([
            {name: "main", ref: "refs/heads/main", remote: false},
            {name: "feature", ref: "refs/heads/feature", remote: false},
            {name: "origin/remote-feature", ref: "refs/remotes/origin/remote-feature", remote: true}
        ]);
        response.body.some(branch => branch.name === "origin/HEAD").should.be.false();
        git(repositoryPath, ["branch", "--show-current"]).should.equal("main");
    });

    it("creates a local tracking branch for a selected remote branch", async function() {
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", repository: "example", branch: "refs/remotes/origin/remote-feature", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);

        const message = await receiveMessage(helper.getNode("repo"), helper.getNode("receiver"), {payload: "keep", topic: "original"});
        message.should.have.property("payload", "keep");
        message.should.have.property("topic", "original");
        message.git.should.deepEqual({
            repository: "example",
            branch: "remote-feature",
            ref: "refs/heads/remote-feature",
            path: fs.realpathSync(repositoryPath)
        });
        git(repositoryPath, ["branch", "--show-current"]).should.equal("remote-feature");
        git(repositoryPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).should.equal("origin/remote-feature");

        fs.writeFileSync(path.join(repositoryPath, "untracked.txt"), "keep");
        const again = await receiveMessage(helper.getNode("repo"), helper.getNode("receiver"), {payload: "again"});
        again.git.ref.should.equal("refs/heads/remote-feature");
        fs.readFileSync(path.join(repositoryPath, "untracked.txt"), "utf8").should.equal("keep");
    });

    it("uses the repository and branch from msg.payload instead of the saved values", async function() {
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", repository: "example", branch: "refs/heads/main", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);
        const payload = {repository: "example", branch: "feature", prompt: "Inspect this branch"};
        const message = await new Promise(function(resolve) {
            helper.getNode("receiver").once("input", resolve);
            helper.getNode("repo").receive({payload});
        });
        message.payload.should.deepEqual(payload);
        message.git.branch.should.equal("feature");
        message.git.ref.should.equal("refs/heads/feature");
        git(repositoryPath, ["branch", "--show-current"]).should.equal("feature");
    });

    it("switches using msg.payload without editor defaults", async function() {
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);
        const message = await new Promise(function(resolve) {
            helper.getNode("receiver").once("input", resolve);
            helper.getNode("repo").receive({payload: {repository: "example", branch: "refs/heads/feature"}});
        });
        message.git.ref.should.equal("refs/heads/feature");
    });

    it("refuses to switch when the working tree is dirty", async function() {
        fs.writeFileSync(path.join(repositoryPath, "untracked.txt"), "keep");
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", repository: "example", branch: "feature", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);
        let received = false;
        helper.getNode("receiver").on("input", function() { received = true; });
        const status = new Promise(resolve => helper.getNode("repo").once("call:status", resolve));
        helper.getNode("repo").receive({payload: "Keep the file"});
        await status;
        received.should.be.false();
        git(repositoryPath, ["branch", "--show-current"]).should.equal("main");
        fs.readFileSync(path.join(repositoryPath, "untracked.txt"), "utf8").should.equal("keep");
    });

    it("does not mix a dynamic repository with a saved branch", async function() {
        await helper.load(gitRepoNode, [{id: "repo", type: "git repo", repository: "example", branch: "feature"}]);
        const status = new Promise(resolve => helper.getNode("repo").once("call:status", resolve));
        helper.getNode("repo").receive({payload: {repository: "example"}});
        await status;
        git(repositoryPath, ["branch", "--show-current"]).should.equal("main");
    });

    it("rejects traversal and repositories outside the configured directory", async function() {
        await helper.load(gitRepoNode, []);
        await helper.request().get("/git-repos/%2E%2E/branches").expect(404);
        await helper.request().get("/git-repos/unknown/branches").expect(404);
    });

    it("reports a missing directory without exposing its path", async function() {
        helper.settings({gitReposDirectory: path.join(root, "missing")});
        await helper.load(gitRepoNode, []);
        const response = await helper.request().get("/git-repos").expect(503);
        response.body.should.deepEqual({error: "Git repository list is unavailable"});
    });

    it("does not forward a message if the saved branch no longer exists", async function() {
        await helper.load(gitRepoNode, [
            {id: "repo", type: "git repo", repository: "example", branch: "refs/heads/deleted", wires: [["receiver"]]},
            {id: "receiver", type: "helper"}
        ]);
        let received = false;
        helper.getNode("receiver").on("input", function() { received = true; });
        const status = new Promise(resolve => helper.getNode("repo").once("call:status", resolve));
        helper.getNode("repo").receive({payload: "keep"});
        await status;
        received.should.be.false();
    });
});
