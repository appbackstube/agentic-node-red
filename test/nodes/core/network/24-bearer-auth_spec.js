const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const bearerAuthNode = require("nr-test-utils").require("@node-red/nodes/core/network/24-bearer-auth.js");

describe("bearer auth Node", function() {
    let AuthNode;
    let credentials;

    function createNode() {
        return new AuthNode({});
    }

    function createMessage(authorization, rawHeaders) {
        const response = {
            headers: {},
            headersSent: false,
            set(name, value) {
                this.headers[name] = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.body = body;
                this.headersSent = true;
                return this;
            }
        };
        return {
            req: {headers: {authorization}, rawHeaders},
            res: {_res: response},
            payload: "unchanged"
        };
    }

    function send(node, message) {
        return new Promise(function(resolve) {
            let output;
            node.emit("input", message, result => { output = result; }, error => resolve({output, error}));
        });
    }

    beforeEach(function() {
        credentials = {token: "example-test-token"};
        bearerAuthNode({
            nodes: {
                createNode(node) {
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                    node.credentials = credentials;
                },
                registerType(name, constructor, options) {
                    assert.equal(name, "bearer auth");
                    assert.deepEqual(options.credentials, {token: {type: "password"}});
                    AuthNode = constructor;
                }
            }
        });
    });

    it("passes the original request with the exact bearer token", async function() {
        const message = createMessage("Bearer example-test-token", ["Authorization", "Bearer example-test-token"]);
        const result = await send(createNode(), message);
        assert.equal(result.error, undefined);
        assert.equal(result.output, message);
        assert.equal(message.res._res.headersSent, false);
        assert.equal(message.payload, "unchanged");
    });

    it("accepts the case-insensitive bearer scheme", async function() {
        const message = createMessage("bearer example-test-token", ["authorization", "bearer example-test-token"]);
        const result = await send(createNode(), message);
        assert.equal(result.output, message);
    });

    for (const header of [undefined, "Basic example-test-token", "Bearer wrong", "Bearer example-test-token-suffix", "Bearer example-test-token extra"]) {
        it("rejects an invalid authorization header: " + String(header), async function() {
            const message = createMessage(header);
            const result = await send(createNode(), message);
            assert.equal(result.output, undefined);
            assert.equal(result.error, undefined);
            assert.equal(message.res._res.statusCode, 401);
            assert.equal(message.res._res.headers["WWW-Authenticate"], "Bearer");
            assert.equal(message.res._res.headers["Cache-Control"], "no-store");
            assert.equal(message.res._res.body, "Unauthorized");
        });
    }

    it("rejects duplicate authorization headers", async function() {
        const message = createMessage("Bearer example-test-token", ["Authorization", "Bearer example-test-token", "AUTHORIZATION", "Bearer wrong"]);
        const result = await send(createNode(), message);
        assert.equal(result.output, undefined);
        assert.equal(message.res._res.statusCode, 401);
    });

    it("fails closed when no token is configured", async function() {
        credentials = {};
        const message = createMessage("Bearer example-test-token");
        const result = await send(createNode(), message);
        assert.equal(result.output, undefined);
        assert.equal(message.res._res.statusCode, 503);
        assert.equal(message.res._res.body, "Service Unavailable");
    });

    it("does not forward a message without an unanswered HTTP response", async function() {
        const message = createMessage("Bearer example-test-token");
        message.res._res.headersSent = true;
        const result = await send(createNode(), message);
        assert.equal(result.output, undefined);
        assert.match(result.error.message, /unanswered HTTP In request/);
    });
});
