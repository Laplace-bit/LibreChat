# Electron desktop client

The desktop client runs the product-owned renderer in `desktop/` and keeps LibreChat's API,
authentication, agents, data and model access on the configured server. The Electron shell and its
native integration live in `desktop/electron/`; do not move desktop-specific changes into
`client/` or change backend behavior as part of shell work.

## Local development

Run `npm run desktop:dev` from the repository root. It starts the Vite renderer and opens the
Electron app. The development launcher reads `BACKEND_HOST`, `BACKEND_PORT` and `HOST` from the
local environment or `.env` so the shell can connect to the same server as Vite. The Electron
renderer uses port 3091 by default; set `AGENT_PLATFORM_RENDERER_PORT` to change it. Set
`AGENT_PLATFORM_SERVER_URL` to override the server address for a local run.

On first launch, enter the organization's HTTP or HTTPS LibreChat server address. The app checks
`/api/config` before saving it. The address is stored under Electron's per-user application data;
the shell does not store a user password or run an agent locally. Use **Agent Platform → Server
Connection…** or **Command + ,** on macOS to open the native settings window. Changing servers clears
the app-origin cookies and browser storage so one server's session cannot be sent to another.

## Request flow

The renderer uses the same relative `/api/...` and `/oauth/...` paths as the web client. Electron
registers a secure, standard `agentplatform://app` origin, serves packaged renderer assets from that
origin, and forwards server routes to the one configured backend. The proxy preserves request and
response streams, forwards browser cookies, and maps server cookies onto the app origin so refresh
tokens remain HttpOnly. `serverDomain` in `/api/config` is mapped back to the app origin so OAuth
starts inside the Electron session. OAuth callback navigation is returned through the proxy before
the renderer resumes; provider-specific OAuth flows still need verification against each target
server configuration.

The renderer has no Node integration. The preload exposes only typed connection and version calls;
the main process checks the sender origin and frame before handling them. Main-window navigation,
new windows, server URLs and persisted window state are validated at their boundaries.

The Electron renderer build skips the web service worker. The packaged app already owns its cache
and navigation lifecycle, so the web worker would add a second owner for those resources.

## Build and package

- `npm run desktop:build` builds the renderer and Electron shell.
- `npm run desktop:package` creates an unpacked platform app.
- `npm run desktop:make` creates a macOS DMG and ZIP on macOS. The ZIP maker is also configured for
  Windows; a signed installer and release updates are separate release work.

The current shell is a runnable baseline. Before release, verify the organization's OAuth provider,
large file upload/download, SSE cancellation/reconnect, audio permissions, screen-reader navigation,
signing and update delivery on each supported OS.
