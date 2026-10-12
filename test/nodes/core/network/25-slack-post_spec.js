const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const slackPostNode = require("nr-test-utils").require("@node-red/nodes/core/network/25-slack-post.js");

describe("slack post Node", function() {
    let PostNode;
    let credentials;
    let createApp;
    let client;
    let calls;

    function node(config) {
        return new PostNode(config);
    }

    function send(postNode, message) {
        return new Promise(function(resolve) {
            let output;
            postNode.emit("input", message, result => { output = result; }, error => resolve({output, error}));
        });
    }

    beforeEach(function() {
        credentials = {botToken: "xoxb-test-not-a-secret", signingSecret: "example-signing-secret"};
        calls = {open: [], post: [], files: []};
        client = {
            conversations: {
                async open(options) {
                    calls.open.push(options);
                    return {ok: true, channel: {id: "D123ABC"}};
                }
            },
            chat: {
                async postMessage(options) {
                    calls.post.push(options);
                    return {ok: true, channel: options.channel, ts: "123.456"};
                }
            },
            async filesUploadV2(options) {
                calls.files.push(options);
                return {ok: true, files: [{ok: true, files: [{id: "F123ABC"}]}]};
            }
        };
        createApp = function(options) {
            assert.deepEqual(options, {
                token: credentials.botToken,
                signingSecret: credentials.signingSecret,
                tokenVerificationEnabled: false
            });
            return {client};
        };
        slackPostNode({
            util: {
                evaluateNodeProperty(value, type, currentNode, message) {
                    return type === "msg" ? value.split(".").reduce((result, key) => result && result[key], message) : value;
                }
            },
            nodes: {
                createNode(currentNode) {
                    currentNode.on = EventEmitter.prototype.on;
                    currentNode.emit = EventEmitter.prototype.emit;
                    currentNode.status = function() {};
                    currentNode.credentials = credentials;
                },
                registerType(name, constructor, options) {
                    assert.equal(name, "slack post");
                    assert.deepEqual(options.credentials, {
                        botToken: {type: "password"},
                        signingSecret: {type: "password"}
                    });
                    PostNode = constructor;
                }
            }
        }, options => createApp(options));
    });

    it("posts to a channel and preserves the message", async function() {
        const message = {payload: "Hello *team*", topic: "keep"};
        const result = await send(node({destinationType: "channel", destination: "C123ABC"}), message);
        assert.equal(result.error, undefined);
        assert.equal(result.output, message);
        assert.equal(message.payload, "Hello *team*");
        assert.equal(message.topic, "keep");
        assert.deepEqual(calls.open, []);
        assert.deepEqual(calls.post, [{channel: "C123ABC", text: "Hello *team*"}]);
        assert.deepEqual(calls.files, []);
        assert.deepEqual(message.slack, {channel: "C123ABC", ts: "123.456"});
    });

    it("uploads msg.payload as a Markdown file without reading a disk path", async function() {
        const message = {payload: "# Report\n\n**Complete**"};
        const result = await send(node({destinationType: "channel", destination: "C123ABC", sendAs: "markdown"}), message);
        assert.equal(result.error, undefined);
        assert.equal(result.output.payload, "# Report\n\n**Complete**");
        assert.deepEqual(calls.files, [{channel_id: "C123ABC", filename: "message.md", content: message.payload}]);
        assert.deepEqual(calls.post, []);
        assert.deepEqual(message.slack, {channel: "C123ABC", fileId: "F123ABC"});
    });

    it("uploads a Markdown file to a user's direct message", async function() {
        const result = await send(node({destinationType: "user", destination: "U123ABC", sendAs: "markdown"}), {payload: "# Hello"});
        assert.equal(result.error, undefined);
        assert.deepEqual(calls.open, [{users: "U123ABC"}]);
        assert.deepEqual(calls.files, [{channel_id: "D123ABC", filename: "message.md", content: "# Hello"}]);
        assert.deepEqual(result.output.slack, {channel: "D123ABC", fileId: "F123ABC"});
    });

    it("accepts a Markdown filename from a message property", async function() {
        const result = await send(node({destinationType: "channel", destination: "C123ABC", sendAs: "markdown", filename: "fileName", filenameType: "msg"}), {
            payload: "# Weekly notes",
            fileName: "weekly.md"
        });
        assert.equal(result.error, undefined);
        assert.equal(calls.files[0].filename, "weekly.md");
    });

    it("rejects a Markdown filename containing a path", async function() {
        const result = await send(node({destinationType: "user", destination: "U123ABC", sendAs: "markdown", filename: "../secret.md"}), {payload: "# Notes"});
        assert.match(result.error.message, /filename must end in \.md/);
        assert.equal(result.output, undefined);
        assert.deepEqual(calls.open, []);
        assert.deepEqual(calls.files, []);
    });

    it("does not forward an upload rejected by Slack", async function() {
        client.filesUploadV2 = async function() {
            return {ok: false, files: []};
        };
        const result = await send(node({destinationType: "channel", destination: "C123ABC", sendAs: "markdown"}), {payload: "# Notes"});
        assert.match(result.error.message, /confirm the file upload/);
        assert.equal(result.output, undefined);
    });

    it("requires a file ID before reporting success", async function() {
        client.filesUploadV2 = async function() {
            return {ok: true, files: [{ok: true, files: []}]};
        };
        const result = await send(node({destinationType: "channel", destination: "C123ABC", sendAs: "markdown"}), {payload: "# Notes"});
        assert.match(result.error.message, /did not return a file ID/);
        assert.equal(result.output, undefined);
    });

    it("opens a DM for a user before posting", async function() {
        const result = await send(node({destinationType: "user", destination: "U123ABC"}), {payload: "Hello"});
        assert.equal(result.error, undefined);
        assert.deepEqual(calls.open, [{users: "U123ABC"}]);
        assert.deepEqual(calls.post, [{channel: "D123ABC", text: "Hello"}]);
        assert.equal(result.output.slack.channel, "D123ABC");
    });

    it("reads recipient and text from selected message properties", async function() {
        const result = await send(node({destinationType: "channel", destination: "target", destinationValueType: "msg", text: "body.text", textType: "msg"}), {
            target: "G123ABC",
            body: {text: "Update"},
            payload: "unchanged"
        });
        assert.equal(result.error, undefined);
        assert.deepEqual(calls.post, [{channel: "G123ABC", text: "Update"}]);
        assert.equal(result.output.payload, "unchanged");
    });

    it("rejects a channel ID when a user is selected", async function() {
        const result = await send(node({destinationType: "user", destination: "C123ABC"}), {payload: "Hello"});
        assert.match(result.error.message, /valid user or channel ID/);
        assert.equal(result.output, undefined);
        assert.deepEqual(calls.post, []);
    });

    it("rejects an empty message", async function() {
        const result = await send(node({destinationType: "channel", destination: "C123ABC"}), {payload: "  "});
        assert.match(result.error.message, /non-empty string/);
        assert.deepEqual(calls.post, []);
    });

    it("requires credentials but never copies them to the message", async function() {
        credentials.signingSecret = undefined;
        const message = {payload: "Hello"};
        const result = await send(node({destinationType: "channel", destination: "C123ABC"}), message);
        assert.match(result.error.message, /token and signing secret are required/);
        assert.equal(message.slack, undefined);
        assert.deepEqual(calls.post, []);
    });

    it("does not expose a token from an SDK error", async function() {
        client.chat.postMessage = async function() {
            throw new Error("request failed with xoxb-test-not-a-secret");
        };
        const result = await send(node({destinationType: "channel", destination: "C123ABC"}), {payload: "Hello"});
        assert.equal(result.error.message, "Slack request failed");
        assert.equal(result.error.cause, undefined);
        assert.equal(result.output, undefined);
    });

    it("reports a Slack API error code without posting an output message", async function() {
        client.chat.postMessage = async function() {
            const error = new Error("Slack API error");
            error.data = {error: "not_in_channel"};
            throw error;
        };
        const result = await send(node({destinationType: "channel", destination: "C123ABC"}), {payload: "Hello"});
        assert.equal(result.error.message, "Slack request failed: not_in_channel");
        assert.equal(result.output, undefined);
    });

    it("does not post when opening the direct message fails", async function() {
        client.conversations.open = async function() {
            return {ok: false};
        };
        const result = await send(node({destinationType: "user", destination: "U123ABC"}), {payload: "Hello"});
        assert.match(result.error.message, /could not open a direct message/);
        assert.deepEqual(calls.post, []);
    });
});
