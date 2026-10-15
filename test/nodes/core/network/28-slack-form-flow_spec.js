const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {execFileSync} = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const slackFormFlow = require("nr-test-utils").require("@node-red/nodes/core/network/28-slack-form-flow.js");
const slackSocketNode = require("nr-test-utils").require("@node-red/nodes/core/network/26-slack-socket.js");
const gitListNode = require("nr-test-utils").require("@node-red/nodes/core/storage/26-git-list.js");

describe("slack form flow Node", function() {
    let FormNode;
    let form;
    let modal;
    let sent;
    let errors;
    let socket;

    function incoming(node, message) {
        return new Promise(resolve => node.emit("input", message, function() {}, error => resolve(error)));
    }

    beforeEach(function() {
        sent = [];
        errors = [];
        modal = undefined;
        socket = {
            id: "socket-1",
            async openForm(interactionId, formId, view) {
                assert.equal(interactionId, "grant-1");
                assert.equal(formId, "form-1");
                modal = view;
                return {ok: true};
            }
        };
        slackFormFlow({
            util: {
                getMessageProperty(message, expression) {
                    return expression.split(".").reduce((value, name) => value && value[name], message);
                }
            },
            nodes: {
                getNode(id) {
                    return id === "socket-1" ? socket : null;
                },
                createNode(node, config) {
                    node.id = config.id;
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                    node.error = error => errors.push(error);
                    node.warn = error => errors.push(error);
                    node.send = output => sent.push(output);
                },
                registerType(name, constructor) {
                    assert.equal(name, "slack form flow");
                    FormNode = constructor;
                }
            }
        });
    });

    it("opens a generic form from message-backed options without forwarding the trigger", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "project", label: "Project", type: "select", source: "msg.payload.projects"},
            {name: "note", label: "Note", multiline: true}
        ])});
        const result = await incoming(form, {
            payload: {projects: ["example"]},
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"}
        });
        assert.equal(result, undefined);
        assert.equal(form.socketId, "socket-1");
        assert.equal(modal.callback_id, "nrflow_form-1");
        assert.equal(modal.blocks[0].element.type, "external_select");
        assert.equal(modal.blocks[0].element.initial_option, undefined);
        assert.equal(modal.blocks[1].element.type, "plain_text_input");
        assert.equal(JSON.stringify(sent).includes("grant-1"), false);
        await form.handleSubmission({
            ack: async function() {},
            body: {user: {id: "U123ABC"}},
            view: {id: "V123ABC", private_metadata: modal.private_metadata, state: {values: {
                project: {"nrflow_form-1_project": {selected_option: {value: "example"}}},
                note: {value: {value: "Ship this"}}
            }}}
        });
        assert.deepEqual(sent[0].payload, {project: "example", note: "Ship this"});
        form.emit("close");
    });

    it("answers option requests from the captured payload without another flow message", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "project", label: "Project", type: "select", source: "msg.payload.projects"}
        ])});
        await incoming(form, {
            payload: {projects: [{label: "Example", value: "example"}]},
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"}
        });
        const acknowledgements = [];
        await form.handleOptions({
            options: {action_id: "nrflow_form-1_project", value: "exa", user: {id: "U123ABC"}, view: {private_metadata: modal.private_metadata}},
            ack: async value => acknowledgements.push(value)
        });
        assert.deepEqual(sent, []);
        assert.deepEqual(acknowledgements, [{options: [{text: {type: "plain_text", text: "Example"}, value: "example"}]}]);
        form.emit("close");
    });

    it("reads repository and dependent branch choices directly from msg.payload", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "repository", label: "Repository", type: "select", source: "msg.payload.repositories"},
            {name: "branch", label: "Branch", type: "select", source: "msg.payload.branches", dependsOn: "repository"},
            {name: "prompt", label: "Prompt"}
        ])});
        const result = await incoming(form, {
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"},
            payload: {
                repositories: ["example", "other"],
                branches: {example: [{label: "Main", value: "refs/heads/main"}, "feature"], other: ["develop"]}
            }
        });
        assert.equal(result, undefined);
        assert.equal(modal.blocks[0].element.type, "external_select");
        assert.equal(modal.blocks[0].element.initial_option, undefined);
        assert.equal(sent.length, 0);
        const repositoryAction = modal.blocks[0].element.action_id;
        const branchAction = modal.blocks[1].element.action_id;
        const repositoryOptions = [];
        await form.handleOptions({
            options: {action_id: repositoryAction, value: "oth", user: {id: "U123ABC"}, view: {private_metadata: modal.private_metadata}},
            ack: async result => repositoryOptions.push(result)
        });
        assert.deepEqual(repositoryOptions[0].options.map(item => item.value), ["other"]);
        assert.equal(sent.length, 0);

        let updated;
        await form.handleAction({
            action: {action_id: repositoryAction, selected_option: {value: "example"}},
            body: {user: {id: "U123ABC"}, view: {
                id: "V123ABC", hash: "h1", private_metadata: modal.private_metadata,
                state: {values: {prompt: {value: {value: "Keep this"}}}}
            }},
            client: {views: {async update(options) { updated = options.view; }}}
        });
        assert.equal(updated.blocks[2].element.initial_value, "Keep this");
        const branchOptions = [];
        await form.handleOptions({
            options: {action_id: branchAction, value: "mai", user: {id: "U123ABC"}, view: {private_metadata: updated.private_metadata}},
            ack: async result => branchOptions.push(result)
        });
        assert.deepEqual(branchOptions[0].options.map(item => item.value), ["refs/heads/main"]);
        const acknowledgements = [];
        await form.handleSubmission({
            ack: async result => acknowledgements.push(result),
            body: {user: {id: "U123ABC"}},
            view: {id: "V123ABC", private_metadata: updated.private_metadata, state: {values: {
                repository: {[repositoryAction]: {selected_option: {value: "example"}}},
                branch: {[branchAction]: {selected_option: {value: "refs/heads/main"}}},
                prompt: {value: {value: "Fix tests"}}
            }}}
        });
        assert.deepEqual(acknowledgements, [undefined]);
        assert.deepEqual(sent[0].payload, {repository: "example", branch: "refs/heads/main", prompt: "Fix tests"});
        assert.equal(sent.length, 1);
        form.emit("close");
    });

    it("leaves a lone option unselected unless the field has an explicit default", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "repository", label: "Repository", type: "select", source: "msg.payload.repositories"},
            {name: "branch", label: "Branch", type: "select", source: "msg.payload.branches", dependsOn: "repository"},
            {name: "priority", label: "Priority", type: "select", source: "static", options: [{label: "High", value: "high"}], default: "high"}
        ])});
        const error = await incoming(form, {
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"},
            payload: {repositories: ["example"], branches: {example: ["main"]}}
        });
        assert.equal(error, undefined);
        assert.equal(modal.blocks[0].element.initial_option, undefined);
        assert.equal(modal.blocks[1].element.initial_option, undefined);
        assert.equal(modal.blocks[2].element.initial_option.value, "high");
        form.emit("close");
    });

    it("rejects a missing message-backed source before opening a modal", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "repository", label: "Repository", type: "select", source: "msg.payload.repositories"}
        ])});
        const error = await incoming(form, {
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"},
            payload: "not an object"
        });
        assert.match(error.message, /msg.payload.repositories must be an array/);
        assert.equal(modal, undefined);
        form.emit("close");
    });

    it("reports an expired trigger instead of hiding the cause", async function() {
        socket.openForm = async function() { throw new Error("Slack form interaction expired"); };
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: '[{"name":"note","label":"Note"}]'});
        const error = await incoming(form, {
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"}
        });
        assert.equal(error.message, "Slack form interaction expired");
        form.emit("close");
    });

    it("reports Slack API error codes from responses and rejected requests", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: '[{"name":"note","label":"Note"}]'});
        const message = {
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"}
        };
        socket.openForm = async function() { return {ok: false, error: "invalid_arguments"}; };
        assert.equal((await incoming(form, message)).message, "Slack form could not open: invalid_arguments");
        socket.openForm = async function() { throw Object.assign(new Error("An API error occurred"), {data: {error: "invalid_trigger"}}); };
        assert.equal((await incoming(form, message)).message, "Slack form could not open: invalid_trigger");
        socket.openForm = async function() { throw Object.assign(new Error("secret"), {data: {error: "secret xoxb-token"}}); };
        assert.equal((await incoming(form, message)).message, "Slack form could not open");
        form.emit("close");
    });

    it("emits a submission only after fresh options verify the selection", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: JSON.stringify([
            {name: "repository", label: "Repository", type: "select", source: "msg.payload.repositories"},
            {name: "branch", label: "Branch", type: "select", source: "msg.payload.branches", dependsOn: "repository"},
            {name: "prompt", label: "Prompt"}
        ])});
        await incoming(form, {
            payload: {repositories: ["example"], branches: {example: [{label: "Main", value: "refs/heads/main"}]}},
            slack: {eventType: "slash_command", command: "/agent", channel: "C123ABC", user: "U123ABC", socketId: "socket-1", interactionId: "grant-1"}
        });
        const values = {
            repository: {"nrflow_form-1_repository": {selected_option: {value: "example"}}},
            branch: {"nrflow_form-1_branch": {selected_option: {value: "refs/heads/fake"}}},
            prompt: {value: {value: "Fix tests"}}
        };
        const acknowledgements = [];
        await form.handleSubmission({
            ack: async value => acknowledgements.push(value),
            body: {user: {id: "U123ABC"}},
            view: {id: "V123ABC", private_metadata: modal.private_metadata, state: {values}}
        });
        assert.deepEqual(acknowledgements[0], {response_action: "errors", errors: {branch: "Select a valid option"}});
        assert.deepEqual(sent, []);
        values.branch["nrflow_form-1_branch"].selected_option.value = "refs/heads/main";
        await form.handleSubmission({
            ack: async value => acknowledgements.push(value),
            body: {user: {id: "U123ABC"}},
            view: {id: "V123ABC", private_metadata: modal.private_metadata, state: {values}}
        });
        assert.equal(acknowledgements[1], undefined);
        assert.deepEqual(sent[0].payload, {
            repository: "example", branch: "refs/heads/main", prompt: "Fix tests"
        });
        form.emit("close");
    });

    it("ignores other commands and malformed forms", async function() {
        form = new FormNode({id: "form-1", command: "/agent", title: "Agent task", fields: '[{"name":"invalid/field","label":"No"}]'});
        assert.equal(errors[0], "Invalid Slack form configuration");
        assert.equal(form.socketId, null);
    });
});

describe("Slack Socket to Git List to canvas Form wiring", function() {
    it("opens a form with Git options and emits the verified submission", async function() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-slack-form-flow-"));
        const repository = path.join(root, "example");
        fs.ensureDirSync(repository);
        function git(args) {
            execFileSync("git", args, {cwd: repository, stdio: "ignore"});
        }
        git(["init"]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
        git(["branch", "-M", "main"]);

        const constructors = {};
        const nodes = new Map();
        const results = [];
        const routed = [];
        const errors = [];
        let opened;
        let resolveOpened;
        const openedPromise = new Promise(resolve => { resolveOpened = resolve; });
        let forward = true;
        const handlers = {};
        const bolt = {
            client: {views: {
                async open(args) {
                    opened = args.view;
                    resolveOpened();
                    return {ok: true};
                }
            }},
            view(pattern, handler) { handlers.view = handler; },
            options(pattern, handler) { handlers.options = handler; },
            action(pattern, handler) { handlers.action = handler; },
            command(pattern, handler) { handlers.command = handler; },
            message() {},
            event() {},
            async start() {},
            async stop() {}
        };
        const RED = {
            settings: {gitReposDirectory: root},
            util: {
                getMessageProperty(message, expression) {
                    return expression.split(".").reduce((value, name) => value && value[name], message);
                }
            },
            nodes: {
                getNode(id) { return nodes.get(id); },
                registerType(type, constructor) { constructors[type] = constructor; },
                createNode(node, config) {
                    node.id = config.id;
                    node.on = EventEmitter.prototype.on;
                    node.emit = EventEmitter.prototype.emit;
                    node.status = function() {};
                    node.error = error => errors.push(error);
                    node.warn = function() {};
                    node.credentials = config.id === "socket-1" ? {botToken: "xoxb-test", appToken: "xapp-test"} : undefined;
                    node.send = function(message) {
                        if (node.id === "socket-1") {
                            routed.push(message);
                            if (forward) {
                                nodes.get("git-list").emit("input", message, function(value) {
                                    nodes.get("form-1").emit("input", value, function() {}, error => {
                                        if (error) { errors.push(error); }
                                    });
                                }, error => {
                                    if (error) { errors.push(error); }
                                });
                            }
                        } else if (node.id === "form-1") {
                            results.push(message);
                        }
                    };
                    nodes.set(node.id, node);
                }
            }
        };
        slackSocketNode(RED, () => bolt);
        gitListNode(RED);
        slackFormFlow(RED);
        const socket = new constructors["slack socket"]({id: "socket-1"});
        new constructors["git list"]({id: "git-list", mode: "formData"});
        const form = new constructors["slack form flow"]({
            id: "form-1", command: "/agent", title: "Task", fields: JSON.stringify([
                {name: "repository", label: "Repository", type: "select", source: "msg.payload.repositories"},
                {name: "branch", label: "Branch", type: "select", source: "msg.payload.branches", dependsOn: "repository"},
                {name: "prompt", label: "Prompt"}
            ])
        });
        try {
            let commandAcked = false;
            await handlers.command({
                command: {command: "/agent", channel_id: "C123ABC", user_id: "U123ABC", text: ""},
                body: {trigger_id: "short-lived-trigger"},
                ack: async function() { commandAcked = true; }
            });
            await openedPromise;
            assert.equal(commandAcked, true);
            assert.equal(opened.callback_id, "nrflow_form-1");
            assert.equal(routed[0].payload.repositories[0].value, "example");
            assert.equal(opened.blocks[0].element.initial_option, undefined);
            assert.equal(opened.blocks[1].element.initial_option, undefined);
            const repositoryOptions = [];
            await handlers.options({
                options: {action_id: "nrflow_form-1_repository", value: "exa", user: {id: "U123ABC"}, view: {private_metadata: opened.private_metadata}},
                ack: async result => repositoryOptions.push(result)
            });
            assert.deepEqual(repositoryOptions[0].options.map(item => item.value), ["example"]);
            let updated;
            await handlers.action({
                ack: async function() {},
                action: {action_id: "nrflow_form-1_repository", selected_option: {value: "example"}},
                body: {user: {id: "U123ABC"}, view: {id: "V123ABC", hash: "h1", private_metadata: opened.private_metadata}},
                client: {views: {async update(args) { updated = args.view; }}}
            });
            const branchOptions = [];
            await handlers.options({
                options: {action_id: "nrflow_form-1_branch", value: "", user: {id: "U123ABC"}, view: {private_metadata: updated.private_metadata}},
                ack: async result => branchOptions.push(result)
            });
            assert.deepEqual(branchOptions[0].options.map(item => item.value), ["refs/heads/main"]);
            let submitted = false;
            await handlers.view({
                ack: async function() { submitted = true; },
                body: {user: {id: "U123ABC"}},
                view: {
                    id: "V123ABC", private_metadata: updated.private_metadata,
                    state: {values: {
                        repository: {"nrflow_form-1_repository": {selected_option: {value: "example"}}},
                        branch: {"nrflow_form-1_branch": {selected_option: {value: "refs/heads/main"}}},
                        prompt: {value: {value: "Prepare changelog"}}
                    }}
                }
            });
            assert.equal(submitted, true);
            assert.deepEqual(results[0].payload, {repository: "example", branch: "refs/heads/main", prompt: "Prepare changelog"});
            assert.equal(results[0].slack.eventType, "form_submission");
            assert.equal(errors.length, 0);
            assert.equal(JSON.stringify(results).includes("short-lived-trigger"), false);

            await assert.rejects(socket.openForm(routed[0].slack.interactionId, form.id, opened), /expired/);
            forward = false;
            await handlers.command({
                command: {command: "/agent", channel_id: "C123ABC", user_id: "U123ABC", text: ""},
                body: {trigger_id: "another-trigger"},
                ack: async function() {}
            });
            const now = Date.now;
            Date.now = () => now() + 3000;
            try {
                await assert.rejects(socket.openForm(routed[1].slack.interactionId, form.id, opened), /expired/);
            } finally {
                Date.now = now;
            }
        } finally {
            form.emit("close");
            await new Promise(resolve => socket.emit("close", resolve));
            fs.removeSync(root);
        }
    });
});
