import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  shell,
  session as defaultSession,
  type MenuItemConstructorOptions,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const APP_SCHEME = 'agentplatform';
const APP_HOST = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_URL = `${APP_ORIGIN}/`;
const CONFIG_FILE = 'server-connection.json';
const WINDOW_FILE = 'window-state.json';
const DEFAULT_WINDOW = { width: 1440, height: 960 };
const MIN_WINDOW = { width: 980, height: 680 };
const RENDERER_ROOT = path.join(__dirname, 'renderer');
const SETUP_FILE = path.join(__dirname, 'setup.html');
const DEV_RENDERER_URL = process.env.AGENT_PLATFORM_RENDERER_URL;
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

type Connection = { serverUrl: string; origin: string; basePath: string };
type PersistedConnection = { serverUrl: string };
type WindowBounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean };

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

app.setName('Agent Platform');
app.setAppUserModelId('com.laplace.agentplatform');
app.setAboutPanelOptions({
  applicationName: 'Agent Platform',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let connection: Connection | null = null;
let oauthUntil = 0;
let writeWindowStateTimer: NodeJS.Timeout | undefined;

function parseConnection(input: string): Connection {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a complete server address, such as https://ai.example.com.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The server address must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The server address cannot include credentials, a query, or a fragment.');
  }
  if (!url.hostname) {
    throw new Error('The server address must include a host name.');
  }

  const basePath = url.pathname.replace(/\/+$/, '');
  const serverUrl = `${url.origin}${basePath}`;
  return { serverUrl, origin: url.origin, basePath };
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

async function readStoredConnection(): Promise<Connection | null> {
  try {
    const content = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(content) as PersistedConnection;
    return parseConnection(parsed.serverUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[desktop] Ignoring invalid saved server connection.');
    }
    return null;
  }
}

async function saveConnection(next: Connection, activeSession: Session): Promise<void> {
  if (connection && connection.serverUrl !== next.serverUrl) {
    await activeSession.clearStorageData({
      origin: APP_ORIGIN,
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    });
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const temporaryPath = `${configPath()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ serverUrl: next.serverUrl }, null, 2), {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, configPath());
  connection = next;
}

function appUrlForPath(pathname: string, search = '', hash = ''): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${APP_ORIGIN}${normalized}${search}${hash}`;
}

function stripServerBasePath(pathname: string, basePath: string): string {
  if (!basePath) {
    return pathname || '/';
  }
  if (pathname === basePath) {
    return '/';
  }
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function mapServerUrlToApp(url: URL, server: Connection): string | null {
  if (url.origin !== server.origin) {
    return null;
  }
  const pathname = stripServerBasePath(url.pathname, server.basePath);
  return appUrlForPath(pathname, url.search, url.hash);
}

function isServerRoute(pathname: string): boolean {
  if (/^\/oauth\/(success|error)\/?$/.test(pathname)) {
    return false;
  }
  return ['/api', '/oauth', '/images', '/login', '/logout', '/register', '/health'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function getTargetUrl(pathname: string, search: string, server: Connection): URL {
  const upstream = new URL(server.origin);
  upstream.pathname = `${server.basePath}${pathname}` || '/';
  upstream.search = search;
  return upstream;
}

function isHtmlNavigation(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('accept')?.includes('text/html') === true;
}

async function serveSetupPage(): Promise<Response> {
  try {
    return await serveLocalFile(SETUP_FILE, 'GET');
  } catch {
    return new Response('Desktop setup page is missing. Rebuild the Electron client.', {
      status: 500,
    });
  }
}

async function serveLocalFile(filePath: string, method: string): Promise<Response> {
  const body = method === 'HEAD' ? null : await fs.readFile(filePath);
  const headers = new Headers({
    'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (body) {
    headers.set('content-length', String(body.byteLength));
  }
  return new Response(body, { status: 200, headers });
}

function safeRendererPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    return null;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  const candidate = path.resolve(RENDERER_ROOT, ...segments);
  const relative = path.relative(RENDERER_ROOT, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

async function serveRenderer(request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/__desktop/setup') {
    return serveSetupPage();
  }
  if (url.pathname === '/setup.css' || url.pathname === '/setup.js') {
    return serveLocalFile(path.join(__dirname, path.basename(url.pathname)), request.method);
  }

  if (DEV_RENDERER_URL) {
    const devUrl = new URL(`${url.pathname}${url.search}`, DEV_RENDERER_URL);
    try {
      return await net.fetch(devUrl.href, { method: request.method, redirect: 'manual' });
    } catch (error) {
      console.error('[desktop] Vite renderer request failed:', devUrl.pathname, error);
      return new Response('The desktop renderer is not reachable. Start the Vite dev server.', {
        status: 502,
      });
    }
  }

  const filePath = safeRendererPath(url.pathname);
  if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return await serveLocalFile(filePath, request.method);
      }
      if (stat.isDirectory()) {
        const indexFile = path.join(filePath, 'index.html');
        if ((await fs.stat(indexFile)).isFile()) {
          return await serveLocalFile(indexFile, request.method);
        }
      }
    } catch {
      // A missing local asset may still be an API route served by the configured server.
    }
  }

  if (isHtmlNavigation(request)) {
    return serveLocalFile(path.join(RENDERER_ROOT, 'index.html'), request.method);
  }
  return new Response('Not found', { status: 404 });
}

function copyResponseHeaders(response: Response, stripRemoteCookieDomain: boolean): Headers {
  const headers = new Headers();
  const cookieHeader = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookieValues = cookieHeader.getSetCookie?.() ?? [];
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== 'set-cookie') {
      headers.append(name, value);
    }
  }

  for (const cookie of setCookieValues) {
    const localizedCookie = stripRemoteCookieDomain
      ? cookie.replace(/;\s*domain=[^;]*/gi, '')
      : cookie;
    headers.append('set-cookie', localizedCookie);
  }
  if (setCookieValues.length === 0) {
    const combinedCookieHeader = response.headers.get('set-cookie');
    if (combinedCookieHeader) {
      headers.append(
        'set-cookie',
        stripRemoteCookieDomain
          ? combinedCookieHeader.replace(/;\s*domain=[^;]*/gi, '')
          : combinedCookieHeader,
      );
    }
  }
  return headers;
}

function isOAuthLandingPath(pathname: string): boolean {
  return /\/oauth\/(success|error)\/?$/.test(pathname);
}

async function proxyServerRequest(
  request: Request,
  requestUrl: URL,
  server: Connection,
): Promise<Response> {
  const upstreamUrl = getTargetUrl(requestUrl.pathname, requestUrl.search, server);
  const headers = new Headers(request.headers);
  for (const name of [
    'host',
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    headers.delete(name);
  }
  const origin = headers.get('origin');
  const fetchSite = headers.get('sec-fetch-site');
  const isAppOriginRequest = origin === APP_ORIGIN;
  if (isAppOriginRequest && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new Response('Cross-site requests are not allowed.', { status: 403 });
  }
  if (
    !isAppOriginRequest &&
    fetchSite === 'cross-site' &&
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    requestUrl.pathname.startsWith('/api/')
  ) {
    return new Response('Cross-site requests are not allowed.', { status: 403 });
  }
  if (isAppOriginRequest) {
    // The custom app origin is the only renderer origin. Map its verified same-origin requests to
    // the configured server origin so the unchanged LibreChat origin guard accepts password login.
    headers.set('origin', server.origin);
    const upstreamPath = `${server.basePath}${requestUrl.pathname}` || '/';
    headers.set('referer', `${server.origin}${upstreamPath}`);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  try {
    const upstream = await net.fetch(upstreamUrl.href, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });

    const responseHeaders = copyResponseHeaders(upstream, true);
    const location = upstream.headers.get('location');
    if (location) {
      try {
        const redirectUrl = new URL(location, upstreamUrl);
        const sameServerRedirect = mapServerUrlToApp(redirectUrl, server);
        if (sameServerRedirect) {
          responseHeaders.set('location', sameServerRedirect);
        } else if (isOAuthLandingPath(redirectUrl.pathname)) {
          const suffix = redirectUrl.pathname.slice(redirectUrl.pathname.lastIndexOf('/oauth/'));
          responseHeaders.set(
            'location',
            appUrlForPath(suffix, redirectUrl.search, redirectUrl.hash),
          );
        }
      } catch {
        // Leave a malformed or non-URL Location header untouched for Chromium to reject.
      }
    }

    const isConfigResponse =
      requestUrl.pathname.endsWith('/api/config') &&
      upstream.headers.get('content-type')?.includes('application/json') === true;
    if (isConfigResponse) {
      try {
        const config = (await upstream.clone().json()) as { serverDomain?: unknown };
        if (typeof config.serverDomain === 'string') {
          config.serverDomain = `${APP_ORIGIN}${server.basePath}`;
          const body = JSON.stringify(config);
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
          return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
          });
        }
      } catch {
        // Preserve the original response if this server returns an unexpected config shape.
      }
    }

    const noBodyStatus = [204, 205, 304].includes(upstream.status);
    return new Response(noBodyStatus ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    console.error('[desktop] Server request failed.');
    return new Response('The configured server could not be reached.', { status: 502 });
  }
}

async function handleAppRequest(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Invalid app URL', { status: 400 });
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) {
    return new Response('Not found', { status: 404 });
  }

  if (url.pathname === '/__desktop/setup') {
    return serveSetupPage();
  }
  if (url.pathname.includes('/oauth/')) {
    oauthUntil = Date.now() + 10 * 60 * 1000;
  }

  if (isServerRoute(url.pathname)) {
    if (!connection) {
      return new Response('Connect this desktop app to a server first.', { status: 503 });
    }
    return proxyServerRequest(request, url, connection);
  }

  if (!connection && !DEV_RENDERER_URL) {
    return Response.redirect(`${APP_ORIGIN}/__desktop/setup`, 302);
  }
  return serveRenderer(request, url);
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  try {
    const sender = new URL(event.senderFrame.url);
    return sender.protocol === `${APP_SCHEME}:` && sender.hostname === APP_HOST;
  } catch {
    return false;
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-server-url', async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error('Untrusted desktop IPC sender.');
    }
    return connection?.serverUrl ?? null;
  });

  ipcMain.handle('desktop:get-app-version', (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error('Untrusted desktop IPC sender.');
    }
    return app.getVersion();
  });

  ipcMain.handle('desktop:connect-to-server', async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error('Untrusted desktop IPC sender.');
    }
    if (typeof input !== 'string' || input.length > 2048) {
      return { ok: false, message: 'Enter a valid server address.' };
    }
    let next: Connection;
    try {
      next = parseConnection(input);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Enter a valid server address.',
      };
    }

    try {
      const response = await net.fetch(getTargetUrl('/api/config', '', next).href, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `The server returned HTTP ${response.status} for /api/config.`,
        };
      }
      const config: unknown = await response.json();
      if (config === null || typeof config !== 'object') {
        return { ok: false, message: 'The address did not return a LibreChat server config.' };
      }
      await saveConnection(next, event.sender.session ?? defaultSession);
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (senderWindow === settingsWindow && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(APP_URL);
        return { ok: true, serverUrl: next.serverUrl, closeSettingsWindow: true };
      }
      return { ok: true, serverUrl: next.serverUrl };
    } catch {
      return {
        ok: false,
        message: 'Could not reach that server. Check the address and your network, then try again.',
      };
    }
  });
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), WINDOW_FILE);
}

function isVisibleOnAnyDisplay(bounds: WindowBounds): boolean {
  const rect = {
    x: bounds.x ?? 0,
    y: bounds.y ?? 0,
    width: bounds.width,
    height: bounds.height,
  };
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x);
    const overlapY =
      Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y);
    return overlapX >= 120 && overlapY >= 100;
  });
}

async function readWindowState(): Promise<WindowBounds> {
  try {
    const value = JSON.parse(await fs.readFile(windowStatePath(), 'utf8')) as WindowBounds;
    if (
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height) ||
      value.width < MIN_WINDOW.width ||
      value.height < MIN_WINDOW.height
    ) {
      return { ...DEFAULT_WINDOW };
    }
    const candidate = {
      ...value,
      width: Math.max(MIN_WINDOW.width, Math.min(value.width, 2600)),
      height: Math.max(MIN_WINDOW.height, Math.min(value.height, 1800)),
    };
    return isVisibleOnAnyDisplay(candidate) ? candidate : { ...DEFAULT_WINDOW };
  } catch {
    return { ...DEFAULT_WINDOW };
  }
}

async function writeWindowState(window: BrowserWindow): Promise<void> {
  const bounds = window.getBounds();
  const state: WindowBounds = {
    ...bounds,
    maximized: window.isMaximized(),
  };
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(windowStatePath(), JSON.stringify(state), { mode: 0o600 });
  } catch (error) {
    console.warn('[desktop] Could not save window state:', error);
  }
}

function scheduleWindowStateWrite(window: BrowserWindow): void {
  if (writeWindowStateTimer) {
    clearTimeout(writeWindowStateTimer);
  }
  writeWindowStateTimer = setTimeout(() => void writeWindowState(window), 250);
}

function isOAuthSuccessPage(url: URL): boolean {
  return isOAuthLandingPath(url.pathname);
}

function bindNavigationPolicy(window: BrowserWindow, contents: WebContents): void {
  contents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(window === settingsWindow ? 'Server Connection' : 'Agent Platform');
  });

  const handleNavigation = (event: Electron.Event, destination: string): void => {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      event.preventDefault();
      return;
    }

    if (url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST) {
      if (isOAuthSuccessPage(url)) {
        oauthUntil = 0;
      }
      return;
    }

    const nowInOAuth = oauthUntil > Date.now();
    if (connection) {
      const mapped = mapServerUrlToApp(url, connection);
      if (mapped && url.pathname.includes('/oauth/')) {
        event.preventDefault();
        void window.loadURL(mapped);
        return;
      }
    }

    if (nowInOAuth && isOAuthLandingPath(url.pathname)) {
      const suffix = url.pathname.slice(url.pathname.lastIndexOf('/oauth/'));
      event.preventDefault();
      void window.loadURL(appUrlForPath(suffix, url.search, url.hash));
      return;
    }

    if (nowInOAuth && (url.protocol === 'https:' || url.protocol === 'http:')) {
      return;
    }

    event.preventDefault();
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      void shell.openExternal(url.href);
    }
  };

  contents.on('will-navigate', handleNavigation);
  contents.on('will-redirect', handleNavigation);
  contents.on('did-create-window', (child) => {
    bindNavigationPolicy(child, child.webContents);
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const destination = new URL(url);
      if (
        (destination.protocol === `${APP_SCHEME}:` && destination.hostname === APP_HOST) ||
        destination.href === 'about:blank'
      ) {
        if (destination.href === 'about:blank') {
          oauthUntil = Date.now() + 10 * 60 * 1000;
        }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: window,
            width: 1100,
            height: 800,
            title: 'Agent Platform',
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              session: contents.session,
              preload: path.join(__dirname, 'preload.cjs'),
            },
          },
        };
      }
      if (destination.protocol === 'https:' || destination.protocol === 'http:') {
        if (oauthUntil > Date.now()) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              parent: window,
              width: 1100,
              height: 800,
              title: 'Agent Platform',
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                session: contents.session,
                preload: path.join(__dirname, 'preload.cjs'),
              },
            },
          };
        }
        void shell.openExternal(destination.href);
      }
    } catch {
      // Invalid and non-HTTP(S) destinations are denied.
    }
    return { action: 'deny' };
  });
}

function openConnectionSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!connection) {
    void mainWindow.loadURL(`${APP_ORIGIN}/__desktop/setup`);
    mainWindow.focus();
    return;
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    parent: mainWindow,
    width: 660,
    height: 560,
    minWidth: 520,
    minHeight: 480,
    resizable: true,
    title: 'Server Connection',
    show: false,
    backgroundColor: '#f5f5f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      session: mainWindow.webContents.session,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  settingsWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
  });
  bindNavigationPolicy(window, window.webContents);
  void window.loadURL(`${APP_ORIGIN}/__desktop/setup`);
}

function buildApplicationMenu(): void {
  const mac = process.platform === 'darwin';
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Server Connection…',
        accelerator: mac ? 'Command+,' : 'Control+,',
        click: openConnectionSettings,
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [appMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Server Connection…', accelerator: 'Control+,', click: openConnectionSettings },
        { type: 'separator' },
        { role: 'close' },
        ...(mac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(mac ? [{ role: 'front' as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const bounds = await readWindowState();
  const window = new BrowserWindow({
    ...DEFAULT_WINDOW,
    ...bounds,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Agent Platform',
    show: false,
    backgroundColor: '#f5f5f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = window;
  if (bounds.maximized) {
    window.maximize();
  }
  window.once('ready-to-show', () => window.show());
  window.on('resize', () => scheduleWindowStateWrite(window));
  window.on('move', () => scheduleWindowStateWrite(window));
  window.on('maximize', () => scheduleWindowStateWrite(window));
  window.on('unmaximize', () => scheduleWindowStateWrite(window));
  window.on('close', () => void writeWindowState(window));
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  bindNavigationPolicy(window, window.webContents);

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, description, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.error('[desktop] Page failed to load:', errorCode, description);
      }
    },
  );
  window.webContents.session.setPermissionRequestHandler(
    (requestingContents, permission, callback, details) => {
      let isAppOrigin = false;
      try {
        const requestingUrl = new URL(details.requestingUrl);
        isAppOrigin =
          requestingContents === window.webContents &&
          requestingUrl.protocol === `${APP_SCHEME}:` &&
          requestingUrl.hostname === APP_HOST;
      } catch {
        isAppOrigin = false;
      }
      callback(isAppOrigin && (permission === 'media' || permission === 'notifications'));
    },
  );

  connection = await readStoredConnection();
  if (!connection && process.env.AGENT_PLATFORM_SERVER_URL) {
    try {
      connection = parseConnection(process.env.AGENT_PLATFORM_SERVER_URL);
    } catch (error) {
      console.warn('[desktop] Ignoring invalid AGENT_PLATFORM_SERVER_URL:', error);
    }
  }

  await window.loadURL(connection || DEV_RENDERER_URL ? APP_URL : `${APP_ORIGIN}/__desktop/setup`);
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    protocol.handle(APP_SCHEME, handleAppRequest);
    registerIpcHandlers();
    buildApplicationMenu();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      } else {
        mainWindow?.show();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (writeWindowStateTimer) {
      clearTimeout(writeWindowStateTimer);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      void writeWindowState(mainWindow);
    }
  });
}
