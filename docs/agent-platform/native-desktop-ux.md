# Mac-first desktop experience

## Product decision

Build one desktop renderer in `desktop/`, with macOS as the design reference and Windows supported
through the same React interface. Keep operating-system differences in Electron's native shell,
keyboard bindings and system integrations; do not maintain separate Mac and Windows layouts.

Electron provides native windows and menus, while the React interface is still rendered by Chromium.
The target is a coherent Mac-first desktop experience, not a claim that HTML controls are AppKit
controls. Prefer system behavior where it is available and keep explicit platform differences
small and understandable.

## Ownership boundaries

- Product UI and desktop-specific styling live in `desktop/`.
- Electron windows, menus, IPC and OS integrations live in `desktop/electron/`.
- `client/` and `packages/client/` stay aligned with upstream LibreChat.
- Authentication, APIs, agents, data and model access stay on the configured LibreChat server.

## Interaction rules

- Use the host system font as the default. Preserve an organization or user font override.
- Let the browser and OS draw scrollbars. Measure their actual gutter for aligned chat content.
- Use native window frames and application menus. Put Mac shortcuts in the application menu and
  Windows shortcuts in the File menu.
- Keep the same component structure and behavior on both platforms. Use `Command` on macOS and
  `Control` on Windows for shared keyboard actions.
- Preserve keyboard focus, reduced-motion and high-contrast behavior while adapting controls.
- Build settings windows from the existing settings components; do not duplicate settings content.

## Current first pass

- The first-run server connection page uses system colors, a compact window and localized feedback.
- The server menu is localized and has one platform-correct shortcut entry.
- The desktop renderer defaults to the system UI font and native cursor behavior.
- Global custom scrollbar geometry was removed; chat layout continues to measure the real gutter.

## Next work

1. Validate the common renderer on a real Windows build, including keyboard accelerators, window
   sizing, light/dark appearance, high contrast, and classic scrollbar geometry.
2. Design a separate native preferences window. The current settings modal is owned by a React
   state tree; a second `BrowserWindow` has independent React and query state even when it shares
   the authenticated Electron session. Before changing this, handle concurrent token refresh,
   preference updates between windows, and logout/session invalidation.
3. Review file dialogs, drag-and-drop, notifications, focus restoration and accessibility against
   the corresponding OS behavior.

## Acceptance checks

- One renderer build serves both macOS and Windows.
- No backend or upstream web-client changes are required for desktop presentation work.
- The first-run flow, login view and settings entry point work in light and dark appearance.
- Platform shortcuts use the correct modifier while shared actions remain the same.
- Scroll alignment is measured rather than based on a fixed scrollbar width.
- Keyboard-only navigation, screen-reader naming, reduced motion and high contrast remain usable.
