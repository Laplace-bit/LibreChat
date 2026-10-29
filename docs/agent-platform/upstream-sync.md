# Upstream sync

The fork keeps two frontend trees with different ownership. `client/` follows LibreChat upstream. `desktop/` is a product-owned copy used as the renderer baseline for the future desktop shell.

## Sync rules

1. Fetch the official repository and identify the LibreChat release or commit used by the server.
2. Update or merge the upstream changes into the fork while preserving `desktop/` and `docs/agent-platform/`.
3. Review changes in `client/`, `packages/client`, `packages/chat`, and `packages/data-provider` together.
4. Port only the required frontend fixes and shared-package compatibility changes into `desktop/`.
5. Keep desktop-only shell, authentication handoff, server URL, and platform integration code inside `desktop/` or its shell subdirectory.
6. Build and test both frontend trees before accepting the sync.

Do not replace `desktop/` with a fresh copy of `client/`. That would erase product changes and defeat the reason for keeping the trees separate. Do not modify backend behavior as part of a routine frontend sync.

## Current package layout

`desktop/` is a root workspace so its local `@librechat/*` and `librechat-data-provider` dependencies resolve to the repository's shared packages. Its package name is separate from the upstream `client` package name. The two renderers still use the same shared package builds.

