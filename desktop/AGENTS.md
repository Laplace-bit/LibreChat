# Agent Platform desktop guidance

Follow the repository-root `AGENTS.md` for shared coding, testing, branching, and review rules. This
file records the product decisions for `desktop/` and `desktop/electron/`.

## Product and architecture

- Keep LibreChat as the upstream baseline and this fork as one root Git repository. Do not create a nested repository under `desktop/`.
- Keep `client/` close to upstream. Treat `desktop/` as the product-owned frontend copy and put desktop-specific renderer changes there. Do not copy desktop-only changes back into `client/`.
- Keep the desktop app connected to the configured LibreChat server. Authentication, users, roles,
  agents, memory, knowledge, model access, business connectors, permissions, audit records, and agent
  execution remain server-side.
- Do not add local agent execution or offline agent behavior. Change backend behavior only after a
  separate decision is recorded in `docs/agent-platform/`.
- Keep renderer pages in the local desktop app and send API requests to the configured server through the Electron shell. Do not proxy frontend pages such as `/login` or `/register` as backend pages.
- Put project-specific documentation in `docs/agent-platform/`.
- Changes to `packages/client`, `packages/chat`, or `packages/data-provider` can affect both web and
  desktop renderers. Make shared changes deliberately and check both apps.

## Cross-platform experience

- Use macOS as the design reference. Keep one shared interface and interaction model across macOS
  and Windows. Add a platform-specific adjustment only when the operating system requires it.
- Follow macOS conventions for windows, menus, shortcuts, dialogs, keyboard navigation, and
  accessibility. Keep the same product experience on Windows.
- Before changing Electron shell interactions, check current Electron documentation and open-source
  examples. Apply the `native-feel-cross-platform-desktop` skill to desktop UX work.

## Development and debugging

- Run `./start.sh` from the repository root to start the local Docker backend services and the
  Vite/Electron development app.
- To use an existing or remote server, run `AGENT_PLATFORM_START_BACKEND=0 AGENT_PLATFORM_SERVER_URL=https://your-server ./start.sh`.
- Give independent recommendations and explain the reasons and tradeoffs. Do not agree with a proposed approach without examining it.
- For a bug, reproduce it, trace the failing layer, fix the cause, and verify the behavior in the
  running desktop app. Do not submit registration forms or create test accounts unless the user asks.
- Keep account emails, usernames, passwords, and tokens out of this file and other repository documentation.

## Delivery

- Keep a runnable baseline committed and pushed before broad UI/UX polishing. Follow the
  repository-root branching and review rules for later work.
