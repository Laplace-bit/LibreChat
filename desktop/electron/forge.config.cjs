const path = require('node:path');

module.exports = {
  packagerConfig: {
    appBundleId: 'com.laplace.agentplatform',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: 'Agent Platform',
    icon: path.join(__dirname, 'assets', 'icon'),
    name: 'Agent Platform',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: { format: 'ULFO' },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
  ],
};
