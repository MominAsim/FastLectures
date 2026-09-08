<h1 align="center">
  <img src="public/penecho-readme-header.png" alt="PenEcho" width="760">
</h1>

<p align="center">
  <strong>English</strong> |
  <a href="docs/readme/README.zh-CN.md">简体中文</a> |
  <a href="docs/readme/README.ja.md">日本語</a> |
  <a href="docs/readme/README.ko.md">한국어</a> |
  <a href="docs/readme/README.ru.md">Русский</a> |
  <a href="docs/readme/README.es.md">Español</a> |
  <a href="docs/readme/README.pt-BR.md">Português (Brasil)</a> |
  <a href="docs/readme/README.fr.md">Français</a> |
  <a href="docs/readme/README.de.md">Deutsch</a>
</p>

<p align="center"><strong>An editable canvas for working with AI.</strong></p>
<p align="center">Draw, explore, and build with the built-in Agent or your own MCP-compatible assistant.</p>
<p align="center">
  <img src="https://img.shields.io/badge/version-1.3.0-087f83" alt="Version 1.3.0">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0-only"></a>
</p>
<p align="center">
  <a href="https://penecho.ai">Website</a> ·
  <a href="https://github.com/penecho/penecho/releases/latest">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/mcp-setup.md">MCP guide</a> ·
  <a href="https://discord.gg/3jrPJ3mXdX">Discord</a>
</p>

<p align="center">
  <img src="https://github.com/penecho/penecho/releases/download/v0.1.0/penecho_full_demo.webp" alt="Handwriting and AI answers on the PenEcho canvas" width="49%">
  <img src="https://github.com/penecho/penecho/releases/download/v0.1.0/penecho_plugins.webp" alt="Editable visual content in PenEcho" width="49%">
</p>

## What you can do

- **Work visually.** Combine handwriting, equations, text, images, diagrams, and interactive HTML Widgets on a spacious canvas.
- **Create with AI.** Use the built-in Agent to research, work with files, explain ideas, and create editable visual results.
- **Bring your own agent.** Connect Codex, Claude Code, or another MCP-compatible client to read and edit an explicitly enabled Canvas.
- **Keep and share your work.** Organize Canvases into projects, save Cloud revisions, sync favorites, and publish through Echoes.

## New in 1.3.0

| Update | What it adds |
| --- | --- |
| **MCP workspace** | Canvas discovery, captures, object editing, interactive Widgets, virtual source files, and user feedback for external agents. Supports opted-in local, LAN, and linked-device Cloud browsers. |
| **PenEcho Cloud Credits API** | Use PenEcho-hosted models with account credits, alongside your own API and CLI connections. View available models, rates, and balance in Settings. |
| **Connection management** | Save multiple AI connections and choose the active connection for each client. |
| **Canvas and workbench** | More responsive drawing and navigation, refined Studio controls, an adaptive Agent panel, and customizable keyboard shortcuts. |

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.png" alt="PenEcho architecture: local and LAN browsers access Canvas on your computer; remote browsers connect through PenEcho Cloud. External agents read and write through the local MCP server. The built-in Agent uses your CLI, model API, or PenEcho Cloud Credits API." width="1488">
</p>

Run PenEcho on your computer as a desktop app or local server. Open its Canvas locally, from a browser on your LAN, or remotely through a Cloud linked device. The built-in Agent uses the AI connection you select; external agents use the local MCP bridge to work on enabled Canvases.

See the [architecture notes](docs/architecture.md) for implementation details.

## Quick start

**Desktop:** download the Windows or macOS app from [GitHub Releases](https://github.com/penecho/penecho/releases/latest).

**npm:** requires Node.js **22.19 or newer**.

```bash
npm install -g penecho
penecho configure
penecho
```

Open `http://localhost:3888`. Configure your own model API or an authenticated Codex, Claude Code, or Kimi CLI. For PenEcho-hosted models, sign in and select an available model in Settings.

At startup, set a six-digit access code or explicitly enable open access on your trusted network. Startup also prints LAN addresses for other devices.

<details>
<summary>Run from source</summary>

```bash
git clone https://github.com/penecho/penecho.git
cd penecho
npm install
npm start
```

</details>

## Connect your agent with MCP

1. Start PenEcho and enable the current Canvas in **Settings → MCP service**.
2. Use Settings to configure a supported local client or copy its generated launch configuration. For a global npm installation, clients that accept `mcpServers` JSON can use:

   ```json
   {
     "mcpServers": {
       "penecho": { "command": "penecho", "args": ["mcp"] }
     }
   }
   ```

3. Ask your agent: **“Show the architecture we discussed on my PenEcho Canvas.”**

The agent can capture relevant content, edit objects, create visual results, patch document source files, and receive your feedback. Only enabled, connected Canvases are discoverable. The MCP client runs on the PenEcho host; LAN and Cloud browser support does not expose a public MCP endpoint.

Desktop installations should use the generated configuration, which includes the correct bundled runtime. See [MCP setup](docs/mcp-setup.md) and the optional [agent workflow skill](skills/penecho-mcp/SKILL.md).

## PenEcho Cloud and AI connections

[PenEcho Cloud](https://penecho.ai) adds private versioned projects, synced favorites, public sharing through Echoes, and remote access to a linked computer.

| Connection | How it works |
| --- | --- |
| **PenEcho models** | Sign in, select an available hosted model, and use account credits. Settings shows current rates and balance. |
| **Your model API** | Configure an OpenAI- or Anthropic-compatible endpoint, model, and API key. Usage is handled by your provider. |
| **Your CLI** | Use a locally installed and authenticated Codex, Claude Code, or Kimi CLI. Availability and usage depend on that provider's plan. |

Hosted models on your computer require a Cloud sign-in, without device pairing or a separate Credits API key. Remote MCP access requires your online linked device and MCP relay support on both the host and Cloud.

Your own API and CLI connections do not spend PenEcho credits. A Cloud account is optional for local use with your own connection. AI features require access to the selected provider; running PenEcho locally does not make a remote model available offline.

## Configuration and data

Use **Settings** for AI connections and Canvas preferences, or `penecho configure` for local server configuration. See the [configuration reference](docs/configuration.md) for endpoints, reasoning settings, timeouts, and CLI options.

Canvases can be stored locally or saved to Cloud. AI requests send the relevant content to the selected provider. Local API credentials are managed by the host; do not share configuration files or traces containing secrets. Keep direct LAN access on a trusted network and use linked-device Cloud access for remote work.

## Community and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) to contribute; run `npm run check` before opening a pull request. Report bugs in [Issues](https://github.com/penecho/penecho/issues), discuss ideas in [Discussions](https://github.com/penecho/penecho/discussions), or join [Discord](https://discord.gg/3jrPJ3mXdX).

PenEcho participates in **Kimi Open Source Friends**. Support the project through [Kimi Code](https://www.kimi.com/code?aff=penecho) or [Kimi Open Platform](https://platform.kimi.ai?aff=penecho).

Licensed under [AGPL-3.0-only](LICENSE). Alternative [commercial licensing](COMMERCIAL-LICENSE.md) is available. See the [trademark policy](TRADEMARKS.md) and [contributor agreement](CONTRIBUTOR-LICENSE-AGREEMENT.md).
