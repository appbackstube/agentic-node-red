<div align="center">

[![License][badge-license]][link-license] [![Build Status][badge-build]][link-build]

<br/><img src="https://nodered.org/about/resources/media/node-red-icon-2.svg" width="150" title="Node-RED Logo"><br/>

[![Nodes][badge-nodes]][link-nodes] [![Flows][badge-flows]][link-flows] [![Collections][badge-collections]][link-collections]

### Low-code programming for event-driven applications

<br/><img src="https://nodered.org/images/node-red-screenshot.png" width="600" alt="Node-RED Screenshot"><br/>

[![Forum][badge-forum]][link-forum] [![GitHub][badge-github]][link-github] [![Slack][badge-slack]][link-slack]

</div>

## Quick Start

Check out https://nodered.org/docs/getting-started/ for full instructions on getting
started.

1. `sudo npm install -g --unsafe-perm node-red`
2. `node-red`
3. Open <http://localhost:1880>

<br/>

> [!NOTE]
> More documentation can be found [here](https://nodered.org/docs). For further help, or general discussion, please join the [Node-RED Forum](https://discourse.nodered.org) or [Node-RED Slack](https://nodered.org/slack).

## Links

- [Documentation ↗](https://nodered.org/docs/)
- [About ↗](https://nodered.org/about/)
- [Installation ↗](https://nodered.org/#get-started)
- [Node-RED Library ↗](https://flows.nodered.org/)
  - [Custom Nodes & Integrations ↗](https://flows.nodered.org/search?type=node)
  - [Shared Flows ↗](https://flows.nodered.org/search?type=flow)
  - [Node Collections ↗](https://flows.nodered.org/search?type=collection)
- [Development](#development)
- [Contributing](#contributing)
- [Copyright and license](#copyright-and-license)

## Development

If you want to run the latest code from git, here's how to get started:

1. Clone the code:

        git clone https://github.com/node-red/node-red.git
        cd node-red

2. Install the node-red dependencies

        npm ci

3. Build the code

        npm run build

4. Run

        npm start

To use a repository-local configuration, create `settings.js` at the repository root.
`npm start` and `npm run dev` load it automatically if present. Use `--settings`
or `--userDir` to choose a different configuration. Set `gitReposDirectory` to
an absolute path to one Git repository or to a directory containing Git
repositories as immediate subdirectories. The local settings file is ignored
by Git because it can contain private configuration. Restart Node-RED after
changing it.

The `git repo` node accepts a configured repository and branch or reads both
from `msg.payload.repository` and `msg.payload.branch`. It checks out the
selected branch before forwarding the message. Switching to another branch
requires a clean working tree; remote-tracking branches create a local tracking
branch without fetching by default. No forced checkout is performed.
The optional **Fetch remote updates** checkbox runs `git fetch --all --prune`
before branch selection. **Fast-forward to latest** also fetches, then advances
the checked-out branch to its upstream with a fast-forward-only merge. It fails
if there is no upstream, the branches have diverged, or the working tree is dirty.
Leave both unchecked to use only locally known refs without changing commit history.

Connect it to a `codex agent` node. Send a prompt in `msg.payload` or configure
the agent to read `msg.payload.prompt` when the payload holds repository, branch,
and prompt together. The agent reads the repository path from `msg.git.path` and
returns its answer in `msg.payload` with thread metadata in `msg.codex`.
The editor fields can instead read other message properties, such as `msg.path`
and `msg.prompt`.
Configure Codex authentication for the Node-RED process before running a flow.
Each input starts a new Codex thread and can use OpenAI credits. The agent is
read-only by default; its editor has an explicit option to allow file edits.
The agent verifies the checked-out branch before it runs.

For Redis-backed jobs, configure a `bullmq redis` server (host, port, database,
optional username/password and TLS) in both `bullmq out` and `bullmq in`.
Set the same queue name on both nodes. `bullmq out` enqueues a JSON-serializable
message and forwards it with `msg.bullmq.jobId`; `bullmq in` receives the job
and emits its message with BullMQ metadata. Set **Simultaneous jobs** on each
`bullmq in` node to control that worker's concurrency (default: 1). A job is
marked complete when it is handed to the Node-RED flow, **not** when downstream
nodes finish; downstream failures do not retry it. Do not send messages with
request/response handles, circular data, or other non-JSON values to the queue.

For HTTP endpoints, connect `http in` -> `bearer auth` -> the protected nodes
-> `http response`. Configure the expected token in the Bearer Auth node's
credential field. It forwards only requests with an exact
`Authorization: Bearer <token>` header; all other requests receive HTTP 401.
Use HTTPS and avoid logging the request's authorization header.

The `slack post` node sends text through the Slack Bolt SDK. Set its bot token
and signing secret as node credentials. Choose a channel ID (`C...` or `G...`)
or a user ID (`U...` or `W...`) for a DM. The text defaults to `msg.payload`;
on success, `msg.slack` contains the posted channel ID and timestamp. Grant
the app `chat:write` and, for direct messages, `im:write`. The node does not
start a Slack event listener or require a public HTTP endpoint.

To send `msg.payload` as an attached Markdown file instead, select **Markdown
file** in the same node. Its contents come from the payload string, not a file
on disk; the default filename is `message.md`. The result contains
`msg.slack.fileId` instead of a message timestamp. Add the `files:write` scope
to the Slack app for file uploads.

Use the `slack socket` input node to receive Slack messages over Bolt Socket
Mode without a public webhook. Configure its bot token and app-level token
(`connections:write`) as credentials, enable Socket Mode, and subscribe to
message events or app mentions in the Slack app. App mentions are the safer
default; enable all messages explicitly if you need them. To receive slash
commands, create a command in the Slack app and grant the `commands` scope.
Reinstall the app in the workspace after changing its OAuth scopes.
Slash commands are enabled by default and acknowledged immediately. Their
argument text is `msg.payload` and the command name is `msg.slack.command`;
the response URL is never forwarded. The output uses `msg.payload`
for text, `msg.topic` for the channel ID, and `msg.slack` for event metadata.
Optional channel and user ID filters narrow the input; a Switch node can route
on `msg.topic`, `msg.slack.user`, or `msg.slack.eventType`. Bot messages and
message edits are ignored. The Socket Mode connection is closed on redeploy.

To open a form from a slash command, use the canvas node `slack form flow`:
`slack socket → your data node → slack form flow`. Configure its command, title,
and fields; new nodes have no preset fields. A select field reads an array from
its configured message path, for example `msg.payload.projects`. Entries may be
strings or `{label:"Project",value:"project-id"}` objects. A dependent select
can read a map of arrays keyed by its parent field's selected value. No option
is selected automatically; an explicit field `default` may preselect one.
The data node must preserve `msg.slack` and finish before Slack's short-lived
trigger expires. The form has one output, carrying submitted field values in
`msg.payload`; no options feedback wiring is needed.
For local Git repositories, one `git list` node in **Slack form data** mode
prepares both collections: wire `slack socket → git list → slack form flow` and
configure select sources as `msg.payload.repositories` and
`msg.payload.branches` (the latter with `dependsOn: "repository"`).
The form itself does not inspect Git or require an options feedback wire in
this mode. Channel and user filters on the Socket node remain optional; without
them, anyone allowed to invoke the command can see the supplied options.
Trigger ID and response URL are never forwarded.

## Contributing

Before raising a pull-request, please read our [contributing guide](https://github.com/node-red/node-red/blob/main/CONTRIBUTING.md).

This project adheres to the [Contributor Covenant 1.4](http://contributor-covenant.org/version/1/4/). By participating, you are expected to uphold this code. Please report unacceptable behavior to any of the project's core team at team@nodered.org.

### Contributors

It is maintained by:

 * Nick O'Leary [@knolleary](http://twitter.com/knolleary)
 * Dave Conway-Jones [@ceejay](http://twitter.com/ceejay)
 * And many others:

<a href="https://github.com/node-red/node-red/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=node-red/node-red" width="100%"/>
</a>

## Copyright and License

Node-RED is a project of the [OpenJS Foundation](http://openjsf.org). Copyright OpenJS Foundation and other contributors, https://openjsf.org under [the Apache 2.0 license](LICENSE).

<br/>
<a href="http://openjsf.org">
<img src="https://raw.githubusercontent.com/node-red/community-survey/refs/heads/main/public/openjs-foundation-logo.svg" width="240" title="OpenJS Foundation Logo">
</a>

<!-- Badge images -->
[badge-license]: https://img.shields.io/badge/License-Apache_2.0-blue.svg?color=3F51B5&style=for-the-badge&label=License&logoColor=000000&labelColor=ececec
[badge-build]: https://img.shields.io/github/actions/workflow/status/node-red/node-red/tests.yml?branch=main&label=Build%20Status&style=for-the-badge
[badge-forum]: https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscourse.nodered.org%2Fabout.json&query=%24.about.stats.users_count&suffix=%20members&label=Forum&logo=discourse&style=for-the-badge&color=0e76b2&logoColor=0e76b2&labelColor=ececec
[badge-github]: https://img.shields.io/badge/dynamic/json?url=https://api.github.com/orgs/node-red&query=$.followers&suffix=%20followers&label=GitHub%20org&style=for-the-badge&logo=github&logoColor=24292F&labelColor=ececec&color=24292F
[badge-slack]: https://img.shields.io/badge/Slack-Join%20Us-4A154B.svg?logo=slack&style=for-the-badge&logoColor=4A154B&labelColor=ececec
[badge-nodes]: https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fflows.nodered.org%2Fthings%3Fformat%3Djson%26per_page%3D1%26type%3Dnode&query=$.meta.results.count&label=Nodes&style=for-the-badge&labelColor=ececec&color=8f0000
[badge-flows]: https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fflows.nodered.org%2Fthings%3Fformat%3Djson%26per_page%3D1%26type%3Dflow&query=$.meta.results.count&label=Flows&style=for-the-badge&labelColor=ececec&color=8f0000
[badge-collections]: https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fflows.nodered.org%2Fthings%3Fformat%3Djson%26per_page%3D1%26type%3Dcollection&query=$.meta.results.count&label=Collections&style=for-the-badge&labelColor=ececec&color=8f0000

<!-- Badge links -->
[link-license]: https://opensource.org/license/apache-2-0
[link-build]: https://github.com/node-red/node-red/actions?query=branch%3Amain
[link-forum]: https://discourse.nodered.org
[link-github]: https://github.com/node-red
[link-slack]: https://nodered.org/slack
[link-nodes]: https://flows.nodered.org/search?type=node
[link-flows]: https://flows.nodered.org/search?type=flow
[link-collections]: https://flows.nodered.org/search?type=collection
[link-nodered]: https://nodered.org/
