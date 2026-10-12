const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const {execFileSync} = require("node:child_process");
const sinon = require("sinon");
const codexAgentNode = require("nr-test-utils").require("@node-red/nodes/core/function/91-codex-agent.js");

describe("codex agent Node", function() {
    let directory;
    let startThread;
    let AgentNode;

    function createAgent(config) {
        return new AgentNode(config);
    }

    function send(node, message) {
        return new Promise(function(resolve) {
            let output;
            node.emit("input", message, function(result) {
                output = result;
            }, function(error) {
                resolve({output, error});
            });
        });
    }

    beforeEach(async function() {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-codex-agent-"));
        const {Codex} = await import("@openai/codex-sdk");
        startThread = sinon.stub(Codex.prototype, "startThread");
        codexAgentNode({
            util: {
                evaluateNodeProperty(value, type, node, message) {
                    if (type === "msg") {
                        return value.split(".").reduce((result, key) => result && result[key], message);
                    }
                    return value;
                }
            },
            nodes: {
                createNode(node) {
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                },
                registerType(name, constructor) {
                    assert.equal(name, "codex agent");
                    AgentNode = constructor;
                }
            }
        });
    });

    afterEach(function() {
        startThread.restore();
        fs.removeSync(directory);
    });

    it("passes the Git repo path and prompt to a read-only Codex thread", async function() {
        let receivedPrompt;
        startThread.callsFake(function(options) {
            assert.deepEqual(options, {
                workingDirectory: fs.realpathSync(directory),
                sandboxMode: "read-only",
                approvalPolicy: "never",
                networkAccessEnabled: false
            });
            return {
                id: "thread-1",
                async run(prompt, options) {
                    receivedPrompt = prompt;
                    assert.ok(options.signal instanceof AbortSignal);
                    return {finalResponse: "Done", usage: {input_tokens: 10}};
                }
            };
        });
        const result = await send(createAgent({}), {git: {path: directory}, payload: "Check this repository", topic: "keep"});

        assert.equal(result.error, undefined);
        assert.equal(receivedPrompt, "Check this repository");
        assert.equal(result.output.payload, "Done");
        assert.equal(result.output.topic, "keep");
        assert.deepEqual(result.output.codex, {threadId: "thread-1", usage: {input_tokens: 10}});
        assert.equal(result.output.git.path, directory);
    });

    it("uses explicit path and prompt with file edits enabled", async function() {
        startThread.callsFake(function(options) {
            assert.equal(options.workingDirectory, fs.realpathSync(directory));
            assert.equal(options.sandboxMode, "workspace-write");
            return {id: "thread-2", run: async prompt => ({finalResponse: prompt, usage: null})};
        });
        const agent = createAgent({directory, directoryType: "str", prompt: "Implement it", promptType: "str", allowEdits: true});
        const result = await send(agent, {payload: "original"});
        assert.equal(result.error, undefined);
        assert.equal(result.output.payload, "Implement it");
    });

    it("accepts path and prompt properties from an incoming message", async function() {
        startThread.returns({id: "thread-4", run: async prompt => ({finalResponse: prompt, usage: null})});
        const agent = createAgent({directory: "path", directoryType: "msg", prompt: "prompt", promptType: "msg"});
        const result = await send(agent, {path: directory, prompt: "Review these files", payload: "previous payload"});

        assert.equal(result.error, undefined);
        assert.equal(result.output.payload, "Review these files");
        assert.equal(startThread.firstCall.args[0].workingDirectory, fs.realpathSync(directory));
    });

    it("rejects a missing prompt before creating a thread", async function() {
        const result = await send(createAgent({}), {git: {path: directory}});
        assert.match(result.error.message, /prompt/);
        assert.equal(result.output, undefined);
        assert.equal(startThread.called, false);
    });

    it("rejects a branch that is not checked out", async function() {
        execFileSync("git", ["init", directory], {stdio: "ignore"});
        const result = await send(createAgent({}), {
            git: {path: directory, ref: "refs/heads/not-the-active-branch"},
            payload: "Change code"
        });
        assert.match(result.error.message, /not checked out/);
        assert.equal(result.output, undefined);
        assert.equal(startThread.called, false);
    });

    it("rejects another message while Codex is running", async function() {
        let finish;
        const running = new Promise(resolve => { finish = resolve; });
        startThread.returns({id: "thread-3", run: async () => running});
        const agent = createAgent({});
        const first = send(agent, {git: {path: directory}, payload: "First"});
        while (!startThread.called) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const second = await send(agent, {git: {path: directory}, payload: "Second"});
        assert.match(second.error.message, /already processing/);
        finish({finalResponse: "First result", usage: null});
        assert.equal((await first).output.payload, "First result");
    });
});
