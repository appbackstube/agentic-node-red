const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
require("bullmq");
const bullmqNode = require("nr-test-utils").require("@node-red/nodes/core/network/92-bullmq.js");

describe("bullmq nodes", function() {
    let types;
    let instances;
    let queues;
    let workers;
    let nextNodeId;

    class FakeQueue extends EventEmitter {
        constructor(name, options) {
            super();
            this.name = name;
            this.options = options;
            this.jobs = [];
            queues.push(this);
        }

        async add(name, data) {
            this.jobs.push({name, data});
            return {id: "job-1", name};
        }

        async close() {
            this.closed = true;
        }
    }

    class FakeWorker extends EventEmitter {
        constructor(name, process, options) {
            super();
            this.name = name;
            this.process = process;
            this.options = options;
            workers.push(this);
        }

        async close() {
            this.closed = true;
        }
    }

    function create(type, config, credentials) {
        instances.currentCredentials = credentials;
        const node = new types[type](config);
        node.id = `node-${++nextNodeId}`;
        instances[node.id] = node;
        return node;
    }

    function send(node, msg) {
        return new Promise(resolve => {
            let output;
            node.emit("input", msg, result => { output = result; }, error => resolve({output, error}));
        });
    }

    function close(node) {
        return new Promise((resolve, reject) => node.emit("close", error => error ? reject(error) : resolve()));
    }

    beforeEach(function() {
        types = {};
        instances = {};
        queues = [];
        workers = [];
        nextNodeId = 0;
        const moduleRecord = require.cache[require.resolve("bullmq")];
        const original = moduleRecord.exports;
        moduleRecord.exports = {Queue: FakeQueue, Worker: FakeWorker};
        try {
            bullmqNode({
                nodes: {
                    createNode(node) {
                        node.on = EventEmitter.prototype.on;
                        node.emit = EventEmitter.prototype.emit;
                        node.send = message => { node.sent = message; };
                        node.status = () => {};
                        node.error = error => { node.lastError = error; };
                        node.credentials = instances.currentCredentials;
                    },
                    registerType(name, constructor) { types[name] = constructor; },
                    getNode(id) { return instances[id]; }
                }
            });
        } finally {
            moduleRecord.exports = original;
        }
        instances.redis = create("bullmq redis", {host: "redis.example", port: "6380", db: "2", tls: true}, {username: "user", password: "secret"});
    });

    it("uses Redis credentials and stores a message before forwarding it", async function() {
        const node = create("bullmq out", {redis: "redis", queue: "tasks", jobName: "work"});
        const msg = {_msgid: "old-id", payload: {action: "run"}, topic: "test"};
        const result = await send(node, msg);
        assert.equal(result.error, undefined);
        assert.equal(queues[0].name, "tasks");
        assert.deepEqual(queues[0].options.connection, {
            host: "redis.example", port: 6380, db: 2, username: "user", password: "secret", tls: {}, maxRetriesPerRequest: 1
        });
        assert.deepEqual(queues[0].jobs, [{name: "work", data: {payload: {action: "run"}, topic: "test"}}]);
        assert.equal(result.output, msg);
        assert.deepEqual(msg.bullmq, {queue: "tasks", jobId: "job-1", name: "work"});
        await close(node);
        assert.equal(queues[0].closed, true);
    });

    it("rejects non-serializable messages and reports queue failures", async function() {
        const node = create("bullmq out", {redis: "redis", queue: "tasks"});
        const circular = {payload: "test"};
        circular.self = circular;
        const result = await send(node, circular);
        assert.ok(result.error);
        assert.equal(result.output, undefined);
        assert.equal(queues[0].jobs.length, 0);
        queues[0].add = async () => { throw new Error("Redis unavailable"); };
        assert.match((await send(node, {payload: "test"})).error.message, /Redis unavailable/);
    });

    it("waits for the flow to acknowledge each job before processing the next", async function() {
        const node = create("bullmq in", {redis: "redis", queue: "tasks", concurrency: "4"});
        const completion = create("bullmq done", {});
        assert.equal(workers[0].name, "tasks");
        assert.equal(workers[0].options.concurrency, 4);
        assert.equal(workers[0].options.connection.maxRetriesPerRequest, null);
        let finished = false;
        const processing = workers[0].process({id: "job-2", name: "work", data: {_msgid: "old-id", payload: "go", topic: "keep"}});
        processing.then(() => { finished = true; });
        assert.equal(node.sent.payload, "go");
        assert.equal(node.sent.topic, "keep");
        assert.equal(node.sent._msgid, undefined);
        assert.equal(node.sent.bullmq.jobId, "job-2");
        assert.equal(node.sent.bullmq.workerId, node.id);
        await Promise.resolve();
        assert.equal(finished, false);
        assert.equal((await send(completion, {...node.sent, bullmq: {...node.sent.bullmq, jobId: "other"}})).error.message,
            "BullMQ job has already finished or does not match this worker");
        assert.equal(finished, false);
        assert.equal((await send(completion, node.sent)).error, undefined);
        await processing;
        assert.equal(finished, true);
        assert.ok((await send(completion, node.sent)).error);
        const second = workers[0].process({id: "job-3", name: "external", data: "value"});
        assert.deepEqual(node.sent.payload, "value");
        await send(completion, node.sent);
        await second;
        await close(node);
        assert.equal(workers[0].closed, true);
    });

    it("fails a job from an error path and rejects a missing completion", async function() {
        const node = create("bullmq in", {redis: "redis", queue: "tasks"});
        const failure = create("bullmq done", {result: "failed"});
        const processing = workers[0].process({id: "job-4", name: "work", data: {payload: "go"}});
        const rejection = assert.rejects(processing, /downstream error/);
        assert.equal((await send(failure, {...node.sent, error: {message: "downstream error"}})).error, undefined);
        await rejection;
        assert.match((await send(failure, {payload: "missing"})).error.message, /No active BullMQ job/);
        await close(node);
    });

    it("releases a pending job when its worker closes", async function() {
        const node = create("bullmq in", {redis: "redis", queue: "tasks"});
        const processing = workers[0].process({id: "job-5", name: "work", data: {}});
        const rejection = assert.rejects(processing, /flow stopped/);
        await close(node);
        await rejection;
    });

    it("does not start a worker without Redis or with invalid concurrency", function() {
        const missing = create("bullmq in", {redis: "missing", queue: "tasks"});
        assert.match(missing.lastError, /Redis server/);
        const invalid = create("bullmq in", {redis: "redis", queue: "tasks", concurrency: "1.5"});
        assert.match(invalid.lastError, /positive integer/);
        const zero = create("bullmq in", {redis: "redis", queue: "tasks", concurrency: 0});
        assert.match(zero.lastError, /positive integer/);
        assert.equal(workers.length, 0);
    });

    it("does not start a queue with no queue name", function() {
        const node = create("bullmq out", {redis: "redis", queue: " "});
        assert.match(node.lastError, /queue name/);
        assert.equal(queues.length, 0);
    });
});
