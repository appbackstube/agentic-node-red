const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const slackSocketNode = require("nr-test-utils").require("@node-red/nodes/core/network/26-slack-socket.js");

describe("slack socket Node", function() {
    let SocketNode;
    let credentials;
    let app;
    let createApp;
    let sent;
    let errors;
    let statuses;

    function createNode(config) {
        return new SocketNode(config);
    }

    function close(node) {
        return new Promise(resolve => node.emit("close", resolve));
    }

    beforeEach(function() {
        sent = [];
        errors = [];
        statuses = [];
        credentials = {botToken: "xoxb-test-not-a-secret", appToken: "xapp-test-not-a-secret"};
        app = {
            handlers: {},
            starts: 0,
            stops: 0,
            message(callback) {
                this.handlers.message = callback;
            },
            event(type, callback) {
                this.handlers[type] = callback;
            },
            command(pattern, callback) {
                this.handlers.command = {pattern, callback};
            },
            view(callbackId, callback) {
                this.handlers.view = {callbackId, callback};
            },
            options(actionId, callback) {
                this.handlers.options = this.handlers.options || {};
                this.handlers.options[actionId] = callback;
            },
            action(actionId, callback) {
                this.handlers.actions = this.handlers.actions || {};
                this.handlers.actions[actionId] = callback;
            },
            async start() {
                this.starts++;
            },
            async stop() {
                this.stops++;
            }
        };
        createApp = function(options) {
            assert.deepEqual(options, {
                token: credentials.botToken,
                appToken: credentials.appToken,
                socketMode: true,
                tokenVerificationEnabled: false
            });
            return app;
        };
        slackSocketNode({
            nodes: {
                getNode(id) {
                    return undefined;
                },
                createNode(node) {
                    node.id = "test-node";
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.send = message => sent.push(message);
                    node.error = error => errors.push(error);
                    node.status = status => statuses.push(status);
                    node.credentials = credentials;
                },
                registerType(name, constructor, options) {
                    assert.equal(name, "slack socket");
                    assert.deepEqual(options.credentials, {
                        botToken: {type: "password"},
                        appToken: {type: "password"}
                    });
                    SocketNode = constructor;
                }
            }
        }, options => createApp(options));
    });

    it("routes text with channel and user metadata", async function() {
        const node = createNode({eventType: "message"});
        await app.handlers.message({message: {text: "Hello", channel: "C123ABC", user: "U123ABC", ts: "123.456"}});
        assert.deepEqual(sent, [{
            payload: "Hello",
            topic: "C123ABC",
            slack: {eventType: "message", channel: "C123ABC", user: "U123ABC", ts: "123.456", threadTs: null}
        }]);
        assert.equal(app.handlers.app_mention, undefined);
        await close(node);
    });

    it("filters by channel and user and ignores bot messages and edits", async function() {
        const node = createNode({eventType: "message", channel: "C123ABC", user: "U123ABC"});
        const event = {text: "Hello", channel: "C123ABC", user: "U123ABC", ts: "123.456", thread_ts: "100.000"};
        await app.handlers.message({message: {...event, channel: "COTHER"}});
        await app.handlers.message({message: {...event, user: "UOTHER"}});
        await app.handlers.message({message: {...event, bot_id: "B123ABC"}});
        await app.handlers.message({message: {...event, subtype: "message_changed"}});
        await app.handlers.message({message: event});
        assert.equal(sent.length, 1);
        assert.equal(sent[0].slack.threadTs, "100.000");
        await close(node);
    });

    it("supports app mentions without receiving normal messages", async function() {
        const node = createNode({eventType: "app_mention"});
        assert.equal(app.handlers.message, undefined);
        await app.handlers.app_mention({event: {text: "<@B123> help", channel: "C123ABC", user: "U123ABC", ts: "123.456"}});
        assert.equal(sent[0].slack.eventType, "app_mention");
        assert.equal(sent[0].payload, "<@B123> help");
        await close(node);
    });

    it("defaults to app mentions instead of every channel message", async function() {
        const node = createNode({});
        assert.equal(app.handlers.message, undefined);
        assert.equal(typeof app.handlers.app_mention, "function");
        assert.equal(typeof app.handlers.command.callback, "function");
        await close(node);
    });

    it("acknowledges a slash command before routing its arguments", async function() {
        const node = createNode({});
        let acknowledged = false;
        node.send = function(message) {
            assert.equal(acknowledged, true);
            sent.push(message);
        };
        assert.equal(app.handlers.command.pattern.test("/agent"), true);
        await app.handlers.command.callback({
            command: {command: "/agent", text: "run tests", channel_id: "C123ABC", user_id: "U123ABC", response_url: "https://secret.example"},
            ack: async function() { acknowledged = true; }
        });
        assert.equal(sent[0].payload, "run tests");
        assert.equal(sent[0].topic, "C123ABC");
        assert.equal(sent[0].slack.command, "/agent");
        assert.equal(sent[0].slack.socketId, "test-node");
        assert.match(sent[0].slack.interactionId, /^[a-f0-9-]{36}$/);
        assert.equal(JSON.stringify(sent).includes("response_url"), false);
        await close(node);
    });

    it("acknowledges slash commands even if command or channel filters reject them", async function() {
        const node = createNode({command: "/agent", channel: "C123ABC", user: "U123ABC"});
        let acknowledgements = 0;
        async function deliver(command, channel, user) {
            await app.handlers.command.callback({
                command: {command, channel_id: channel, user_id: user, text: "hello"},
                ack: async function() { acknowledgements++; }
            });
        }
        await deliver("/other", "C123ABC", "U123ABC");
        await deliver("/agent", "COTHER", "U123ABC");
        await deliver("/agent", "C123ABC", "UOTHER");
        assert.equal(acknowledgements, 3);
        assert.deepEqual(sent, []);
        await deliver("/agent", "C123ABC", "U123ABC");
        assert.equal(acknowledgements, 4);
        assert.equal(sent[0].slack.command, "/agent");
        await close(node);
    });

    it("can disable slash commands", async function() {
        const node = createNode({includeCommands: false});
        assert.equal(app.handlers.command, undefined);
        await close(node);
    });

    it("ignores obsolete inline form settings and still forwards slash commands", async function() {
        const node = createNode({enableForm: true, form: "missing", formFields: "{", formCommand: "/agent"});
        await app.handlers.command.callback({
            command: {command: "/agent", text: "run", channel_id: "C123ABC", user_id: "U123ABC"},
            body: {trigger_id: "short-lived-trigger"},
            ack: async function() {}
        });
        assert.equal(sent[0].payload, "run");
        assert.equal(sent[0].slack.command, "/agent");
        assert.deepEqual(errors, []);
        await close(node);
    });

    it("can route both event types", async function() {
        const node = createNode({eventType: "both"});
        assert.equal(typeof app.handlers.message, "function");
        assert.equal(typeof app.handlers.app_mention, "function");
        await close(node);
    });

    it("fails closed without a bot or app token", async function() {
        credentials.appToken = undefined;
        const node = createNode({});
        assert.equal(app.starts, 0);
        assert.equal(errors[0], "Slack Socket Mode requires bot and app tokens");
        assert.equal(statuses[0].fill, "red");
        await close(node);
    });

    it("closes the connection and stops routing on redeploy", async function() {
        const node = createNode({eventType: "message"});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.starts, 1);
        await close(node);
        assert.equal(app.stops, 1);
        await app.handlers.message({message: {text: "Too late", channel: "C123ABC", user: "U123ABC"}});
        assert.deepEqual(sent, []);
    });

    it("stops again if the connection opens after the node closes", async function() {
        let finishStart;
        app.start = function() {
            return new Promise(resolve => { finishStart = resolve; });
        };
        const node = createNode({eventType: "message"});
        await new Promise(resolve => setImmediate(resolve));
        await close(node);
        assert.equal(app.stops, 1);
        finishStart();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.stops, 2);
        assert.notEqual(statuses[statuses.length - 1].text, "connected");
    });

    it("does not log a token when Socket Mode fails to connect", async function() {
        app.start = async function() {
            throw new Error("xapp-test-not-a-secret failed");
        };
        const node = createNode({eventType: "message"});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(errors[0], "Slack Socket Mode could not connect");
        assert.equal(statuses[statuses.length - 1].fill, "red");
        await close(node);
    });
});
