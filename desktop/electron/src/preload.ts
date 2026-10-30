import { contextBridge, ipcRenderer } from 'electron';

export type ConnectionResult =
  | { ok: true; serverUrl: string; closeSettingsWindow?: boolean }
  | {
      ok: false;
      code: 'invalid-address' | 'server-error' | 'not-librechat' | 'unreachable' | 'storage-error';
    };

export interface DesktopShellAPI {
  getServerUrl: () => Promise<string | null>;
  connectToServer: (serverUrl: string) => Promise<ConnectionResult>;
  getAppVersion: () => Promise<string>;
}

const desktopShell: DesktopShellAPI = Object.freeze({
  getServerUrl: () => ipcRenderer.invoke('desktop:get-server-url'),
  connectToServer: (serverUrl: string) =>
    ipcRenderer.invoke('desktop:connect-to-server', serverUrl),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
});

contextBridge.exposeInMainWorld('desktopShell', desktopShell);
