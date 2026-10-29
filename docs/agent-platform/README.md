# Agent platform client

This directory contains the product decisions and implementation notes for the factory AI client built on top of LibreChat.

## Current decision

- LibreChat remains the server platform and runs inside each customer's plant network.
- Agent execution stays on the server. The desktop application is a client of the server, not a second agent runtime.
- The first business scope is read-only MES, ERP, and WMS queries, followed by cross-system analysis and reports.
- The server owns users, roles, agent definitions, model and provider access, memory, knowledge, business connectors, authorization, and audit records.
- The first desktop targets are macOS and Windows.
- The backend remains unchanged during the initial client baseline. Deployment configuration and authentication integration may still need validation for a desktop origin.

The initial renderer copy is based on the Fork's current `main` commit `8d3da9bbb` (2026-10-26). Keep this reference until the first intentional upstream sync.

## Repository boundaries

| Path | Ownership | Rule |
| --- | --- | --- |
| `client/` | Upstream-aligned web client | Keep close to the matching LibreChat release. Do not add desktop-specific behavior here. |
| `desktop/` | Product-owned renderer copy | Port selected upstream changes here and add desktop shell integration here. |
| `packages/client`, `packages/chat`, `packages/data-provider` | Shared dependencies | Treat changes as affecting both renderers. Build and test both entry points. |
| `api/`, `packages/api`, `packages/data-schemas` | Server | Leave unchanged for the initial client work. |
| `docs/agent-platform/` | Product documentation | Put decisions, architecture notes, test plans, and sync notes here. |

The copied renderer is intentionally separate from `client/` so an upstream sync does not turn every desktop customization into a conflict. This does not isolate shared packages: updates to the shared packages still need to be reviewed and may require a deliberate port into `desktop/`.

## What still needs to be built

1. Choose and implement the macOS and Windows shell around `desktop/`.
2. Add a configurable server URL and verify login, OAuth return paths, refresh cookies, file transfers, and SSE streaming inside the shell.
3. Define desktop packaging, signing, update delivery, and support for the customer's internal network.
4. Run the acceptance path on both systems: sign in, query an authorized read-only business connector, stream a response, cancel it, restore the conversation, and enforce server-side authorization.

