import { isChatRoute, isConfigWorkspacePanel } from '../constants';

describe('configuration workspace panels', () => {
  it.each(['agents', 'assistants', 'parameters', 'mcp-builder'])(
    'uses the main work area for %s',
    (panelId) => {
      expect(isConfigWorkspacePanel(panelId)).toBe(true);
    },
  );

  it.each(['conversations', 'skills', 'prompts', 'memories', 'bookmarks'])(
    'keeps %s in the regular sidebar layout',
    (panelId) => {
      expect(isConfigWorkspacePanel(panelId)).toBe(false);
    },
  );

  it('only uses the expanded workspace for chat routes', () => {
    expect(isChatRoute('/c/new')).toBe(true);
    expect(isChatRoute('/c/abc123')).toBe(true);
    expect(isChatRoute('/agents')).toBe(false);
    expect(isChatRoute('/skills')).toBe(false);
  });
});
