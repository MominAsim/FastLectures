# Contributing to FastLectures

Thank you for improving FastLectures.

## Development Setup

1. Install Node.js 18 or newer.
2. Install dependencies and link this checkout's command:

   ```bash
   npm install
   npm link
   ```

3. Run `fastlectures configure` and choose API, Codex CLI, or Claude CLI. Codex and Claude modes require their installed CLI to be authenticated first.
4. Run `fastlectures` and open `http://localhost:3888`, or use this computer's LAN IP from another device on the same trusted network.

The default development configuration is the same global `~/.fastlectures/config.env` used by the installed package. For an isolated test setup, use `fastlectures configure --config ./local.env` and `fastlectures --config ./local.env`. Project `.env` files are not loaded automatically.

## Before Submitting Changes

Run:

```bash
npm run check
```

For browser-facing changes, verify desktop and mobile layouts and test stylus/mouse drawing, touch navigation, Manual/Auto AI delay controls, AI draft confirmation, New canvas choices, and local snapshots.

## Engineering Guidelines

- Keep server secrets out of `public/`, logs, screenshots, and test fixtures.
- Preserve the sparse tile architecture. Do not allocate a full 20k canvas bitmap.
- Keep English as the default interface and source-facing language. Add user-visible Chinese copy through the localization table.
- Do not persist unconfirmed AI drafts in local snapshots.
- Use dependencies only when their licenses explicitly permit commercial use.
- Keep changes focused and document new data formats or external services.

## Contribution Licensing

FastLectures is offered under `AGPL-3.0-only` and may also be offered under separate commercial terms. To keep both paths possible, every copyrightable contribution is subject to the [FastLectures Contributor License Agreement](CONTRIBUTOR-LICENSE-AGREEMENT.md).

You retain ownership of your contribution. You grant the Project Owner a non-exclusive license to include it in the public AGPL project and in commercially licensed FastLectures editions. Any accepted contribution used in a commercial edition must also remain available in the canonical repository under `AGPL-3.0-only`.

By opening a pull request and confirming the contributor-agreement checkbox, you accept those terms. Do not submit code owned by an employer or another party unless you have permission to grant these rights.

## Pull Requests

Describe the user-visible behavior, implementation approach, validation performed, and any known limitations. Avoid committing configuration files containing credentials, logs, browser test output, local agent state, or generated dependency directories.
