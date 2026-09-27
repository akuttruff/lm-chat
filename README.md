# LM Chat

A mobile web client for [LM Studio](https://lmstudio.ai). Run a model on your
computer and chat with it from your phone over your own Wi-Fi, including the
MCP tools you already have set up in LM Studio.

Everything stays on your network: no cloud service, no account, no third-party
API.

## Features

- **Streaming replies** with live status: loading, reading the prompt,
  reasoning, writing, or calling a tool.
- **Reasoning shown, not discarded**, as a collapsible "Thought for 4.2s" block.
- **MCP tool calls** rendered as cards with their output.
- **Conversations saved on your computer**, so they survive a closed tab or a
  locked phone and are shared across your devices.
- **Several chats at once**: switch between chats while they reply; extra
  messages wait their turn instead of overloading the model.
- **Per-chat reasoning effort**, offering only the levels the loaded model
  actually accepts.
- **Automatic context compaction**: long threads have their older turns
  summarized, so each message stays fast without the model losing track.

## Requirements

- LM Studio 0.4.0 or newer, with a model loaded
- Node 20.7 or newer
- A phone on the same network as your computer

## Setup

1. In LM Studio's **Developer** tab, start the server.
2. Turn on **Require Authentication** and create a token under
   **Manage Tokens**. (Authentication is required for MCP tools.)
3. To use MCP tools, also enable **Allow calling servers from mcp.json**.
4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

5. Open the **Network** URL that Vite prints (e.g. `http://192.168.1.50:8000/`)
   on your phone. Use `http://`, not `https://`.
6. Tap the gear, paste your API token, tap **Test connection**, and pick a model.

> Paste the token rather than typing it: tokens are case-sensitive, and some
> apps lowercase part of them when copying. The Settings screen warns if the
> token looks mangled.

## How it works

```
phone ──http──▶ LM Chat server (your computer) ──▶ LM Studio on 127.0.0.1:1234
```

The phone never talks to LM Studio directly. The LM Chat server, which runs
inside the Vite dev server, sends each message to LM Studio, streams the reply
back, and saves it. So:

- **A reply keeps going** if you lock your phone or close the tab.
- **Your API token stays on your computer.** It is never sent to the browser.
- **Data lives in `.data/`** in the project folder: `conversations.json` and
  `config.json`. It is git-ignored.

Each message carries its own conversation history rather than relying on
LM Studio's server-side chat state, so one failed reply can't make the model
forget the thread. When that history grows past the budget set in Settings, the
older turns are replaced by a summary the model writes.

## Settings

| Setting | Notes |
|---|---|
| LM Studio address | Defaults to `http://127.0.0.1:1234`. |
| Model | Filled in by **Test connection**. |
| API token | Required when LM Studio has authentication on. |
| System prompt | Sent with every message. |
| Default reasoning effort | For new chats; each chat can override it. |
| Give up after | Seconds of *silence* before a reply is abandoned. `0` waits forever. |
| Parallel replies | How many chats can be answered at once (default 4). Match the model's **Parallel** setting in LM Studio; extra messages wait in the app and show as queued. `0` means no limit. |
| Conversation replayed | Characters of history sent with each message (default 24000). Older turns are summarized. `0` sends everything, uncompressed. |
| Context length | Leave blank. It applies when a model is loaded, and setting it here makes LM Studio load a new model instance for every message. |
| Plugin IDs | MCP plugins to enable, comma-separated, e.g. `mcp/filesystem, mcp/web-search`. |

## Development

```bash
npm run dev        # dev server on :8000, reachable on your network
npm test           # run the test suite
npm run coverage   # coverage report
npm run check      # typecheck, lint and test
```

## Limitations

- **No authentication on the app itself.** Anyone who can reach port 8000 can
  read your conversations and change settings. Only run it on a network you
  trust.
- **Single user.** There are no accounts, and two devices editing the same
  conversation at once can overwrite each other.
- **Dev server only.** The chat server runs inside `npm run dev`; a static
  `npm run build` has no server behind it.

## License

[MIT](LICENSE)
