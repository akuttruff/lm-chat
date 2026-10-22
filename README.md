# <img src="public/icon-180.png" width="32" alt=""> LM Chat

A mobile web client for [LM Studio](https://lmstudio.ai). Run a model on
your computer and chat with it from your phone over your own Wi-Fi,
including the MCP tools you already have set up in LM Studio.

Everything stays on your network: no cloud service, no account, no
third-party API.

## What it looks like

<img src="docs/screenshots/desktop.png" alt="Desktop: the chat list beside the thread" />

**On a desktop.** The chat list in a sidebar beside the thread.

<img src="docs/screenshots/demo-desktop.gif" alt="LM Chat in use on a desktop" />

<p><b>In use.</b> On a desktop: a thread with its tool cards, then another chat from the list.</p>

<p align="center"><img src="docs/screenshots/demo-phone.gif" width="300" alt="LM Chat in use on a phone" /></p>

<p align="center">The same, on a phone.</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/thread-phone.png" alt="A chat with tool calls" /></td>
    <td width="50%"><img src="docs/screenshots/reasoning-phone.png" alt="The reasoning block open" /></td>
  </tr>
  <tr>
    <td><b>A chat.</b> The question, the model's thinking as a row, the MCP tools it called as cards, then the reply.</td>
    <td><b>Reasoning.</b> Kept, not discarded: tap the row to read what the model thought.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/tools-phone.png" alt="The reply written from the tool results" /></td>
    <td><img src="docs/screenshots/table-phone.png" alt="A reply with a table" /></td>
  </tr>
  <tr>
    <td><b>The reply.</b> Markdown, then what the turn cost: model, time, tokens per second, tokens in and out.</td>
    <td><b>Tables</b> and the rest of Markdown render as you would expect.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/code-phone.png" alt="A reply with code" /></td>
    <td><img src="docs/screenshots/chats-phone.png" alt="The chat list" /></td>
  </tr>
  <tr>
    <td><b>Code</b> comes with copy and save buttons.</td>
    <td><b>Chats.</b> Folders, stars and search. Each chat can have its own reasoning level and memory setting.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/settings-phone.png" alt="Settings" /></td>
    <td><img src="docs/screenshots/memories-phone.png" alt="Memories" /></td>
  </tr>
  <tr>
    <td><b>Settings.</b> The LM Studio address and token, the model, reasoning, and how much history each message carries.</td>
    <td><b>Memories.</b> What the model has learned about you, in a file you can read, edit and prune.</td>
  </tr>
</table>

The screenshots use demo data. To regenerate them:

```bash
npm run seed:demo                                  # once
MEMORY_DB=$PWD/.data-dev/memory.sqlite npm run dev  # one terminal
npm run screenshots                                # another; needs Google Chrome
```

## Features

- **Streaming replies** with live status: loading, reading the prompt,
  reasoning, writing, or calling a tool.
- **Reasoning shown, not discarded**, as a collapsible "Thought for 4.2s"
  block.
- **MCP tool calls** rendered as cards with their arguments and output.
- **Conversations saved on your computer**, so they survive a closed tab or
  a locked phone and are shared across your devices. Folders, stars and
  search keep them in order.
- **Several chats at once.** Switch between chats while they reply. Extra
  messages wait their turn instead of overloading the model.
- **Memories.** What the model has learned about you, kept in a file you
  can read and edit, and offered to each chat or left out of it.
- **Read aloud.** Each reply can be spoken by a local voice model.
- **Per-chat reasoning effort**, offering only the levels the loaded model
  accepts.
- **Automatic context compaction.** Long threads have their older turns
  summarized, so each message stays fast without the model losing track.

## Before you start

### How it fits together

```
your phone or desktop browser
        │  http, over your own network
        ▼
LM Chat ── one Node process on one computer ── .data/ (SQLite)
        │
        ├──▶ a model server on the same computer   (every reply; MCP tools run inside it)
        └──▶ a speech server, optional             (read aloud)
```

LM Chat is one Node process that serves the app to any browser on your
network and keeps your conversations in SQLite on that computer. Your phone
talks only to LM Chat. LM Chat talks to the model server, streams the reply
back and saves it, which is why a reply keeps going when the phone locks
and why the server's token never reaches the browser. MCP tools are set up
in the model server, not here; LM Chat shows them and lets each chat choose
among them.

### What you need

| For | You need |
|---|---|
| Chatting | Node 24 or newer, and a model server with a chat model (below) |
| Calling tools from a chat | MCP servers registered with the model server, and its authentication on |
| Memories | The [lm-memory-mcp](https://github.com/akuttruff/lm-memory-mcp) server registered the same way; the model uses it to remember and forget |
| Reading replies aloud | A local speech server (below) |
| Opening it on your phone | The phone on the same Wi-Fi, or [Tailscale](https://tailscale.com) on both devices (see *Development*) |

Node 24 is the floor because conversations are stored with `node:sqlite`,
which arrived in that version. Check with `node --version`.

### A model server

LM Chat sends each turn to a model server's `/api/v1/chat` endpoint, the
API that [LM Studio](https://lmstudio.ai) 0.4 introduced, because it
carries MCP tool calls, reasoning levels, images and streamed replies in
one request. LM Studio is the server these steps use. Any other server
that implements that same API works the same way; one that offers only
the OpenAI chat API does not, yet. The server can run on the same computer
as LM Chat or on one it can reach.

1. Install the server and download a chat model. In LM Studio that is the
   Discover tab. LM Chat is written and tested against `qwen/qwen3.8-27b`;
   any chat model works, and a smaller one answers faster.
2. Start the server. In LM Studio that is the **Developer** tab. It listens
   on `http://127.0.0.1:1234`, LM Chat's default; Settings takes another
   address.
3. Turn authentication on and create a token. In LM Studio: **Require
   Authentication**, then **Manage Tokens**. LM Studio requires this for MCP
   tools. The token is kept on the LM Chat server and never sent to the
   browser.
4. For tools, register the MCP servers you want with the model server. In
   LM Studio that is `~/.lmstudio/mcp.json` plus **Allow calling servers
   from mcp.json** in the Developer settings. LM Chat reads that same file
   to show each server's tools in its tool picker.
5. Set how many requests the model serves at once (in LM Studio, the
   model's **Parallel** setting) and match it in LM Chat's Settings.

### A speech server

Read-aloud needs a server that speaks the OpenAI `/v1/audio/speech` API on
`127.0.0.1:8020`. `scripts/lm-speech` starts
[mlx-audio](https://github.com/Blaizzy/mlx-audio) with the Kokoro voice on
an Apple Silicon Mac; its header says how to set that environment up once
with `uv`. Any server with the same endpoint works, with `LM_SPEECH_URL`
and `LM_SPEECH_MODEL` pointing at it. Without one, the speak button
reports that no voice is running.

## Setup

1. Get a model server running, as above.
2. Install and run:

   ```bash
   npm install
   npm run dev
   ```

3. Open the **Network** URL that Vite prints (for example
   `http://192.168.1.50:8000/`) on your phone. Use `http://`, not `https://`.
4. Tap the gear, enter the model server's address if it is not the
   default, paste its token, tap **Test connection**, and pick a model.

> Paste the token rather than typing it. Tokens are case-sensitive, and
> some apps lowercase part of them when copying. The Settings screen warns
> if the token looks mangled.

## How it works

```
phone ──http──▶ LM Chat server (your computer) ──▶ LM Studio on 127.0.0.1:1234
```

The phone never talks to LM Studio directly. The LM Chat server sends each
message to LM Studio, streams the reply back, and saves it. So:

- **A reply keeps going** if you lock your phone or close the tab.
- **Your API token stays on your computer.** It is never sent to the
  browser.
- **Data lives in `.data/`** in the project folder, as SQLite. It is
  git-ignored. `npm run dev` uses a scratch copy in `.data-dev/`.

Each message carries its own conversation history rather than relying on
LM Studio's server-side chat state, so one failed reply cannot make the
model forget the thread. When that history grows past the budget set in
Settings, the older turns are replaced by a summary the model writes.

The page itself is served from the browser's cache on every launch, so the
app opens at once on the phone even before its network is up, and shows a
notice if the server cannot be reached.

## Settings

| Setting | Notes |
|---|---|
| LM Studio address | Defaults to `http://127.0.0.1:1234`. |
| Model | Filled in by **Test connection**. |
| API token | Required when LM Studio has authentication on. |
| System prompt | Sent with every message. |
| Default reasoning effort | For new chats; each chat can override it. |
| Give up after | Seconds of *silence* before a reply is abandoned. `0` waits forever. |
| Parallel replies | How many chats can be answered at once (default 4). Match the model's **Parallel** setting in LM Studio. `0` means no limit. |
| Conversation replayed | Characters of history sent with each message (default 24000). Older turns are summarized. `0` sends everything. |
| Context length | Leave blank. Setting it here makes LM Studio load a new model instance for every message. |
| Plugin IDs | MCP plugins to enable, comma-separated, for example `mcp/filesystem, mcp/web-search`. |

## Development

```bash
npm run dev          # dev server on :8000, reachable on your network
npm test             # run the test suite
npm run coverage     # coverage report
npm run check        # typecheck, lint and test
npm run deploy       # build and restart the persistent instance on :8010
npm run seed:demo    # fill the dev database with demo chats and memories
npm run screenshots  # regenerate docs/screenshots/ from the dev server
```

The persistent instance is a launchd job (`com.amie.lm-chat`) running
`vite preview` on :8010. Read-aloud needs the companion `com.amie.lm-speech`
job, which runs Kokoro on :8020 (see `scripts/lm-speech`). To reach it from
anywhere, put :8010 behind Tailscale Serve:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:8010
```

## Limitations

- **No authentication on the app itself.** Anyone who can reach the port
  can read your conversations and change settings. Only run it on a network
  you trust.
- **Single user.** There are no accounts, and two devices editing the same
  conversation at once can overwrite each other.

## License

[MIT](LICENSE)
