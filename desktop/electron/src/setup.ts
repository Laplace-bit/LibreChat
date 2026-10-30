import type { ConnectionResult, DesktopShellAPI } from './preload';

type ConnectionErrorCode = Extract<ConnectionResult, { ok: false }>['code'];

type SetupCopy = {
  language: string;
  pageTitle: string;
  heading: string;
  description: string;
  addressLabel: string;
  addressPlaceholder: string;
  connect: string;
  connecting: string;
  connected: (serverUrl: string) => string;
  opening: string;
  footer: string;
  submissionError: string;
  errors: Record<ConnectionErrorCode, string>;
};

const englishCopy: SetupCopy = {
  language: 'en',
  pageTitle: 'Connect to a server · Agent Platform',
  heading: 'Connect to your server',
  description:
    "Connect this desktop app to your organization's LibreChat server. Your account and AI services stay on that server.",
  addressLabel: 'Server address',
  addressPlaceholder: 'https://ai.example.com',
  connect: 'Connect',
  connecting: 'Connecting…',
  connected: (serverUrl) => `Connected to ${serverUrl}`,
  opening: 'Opening Agent Platform…',
  footer: 'Use the address provided by your organization.',
  submissionError: 'The desktop app could not complete the connection. Try again.',
  errors: {
    'invalid-address': 'Enter a valid HTTP or HTTPS server address.',
    'server-error': 'The server could not complete the connection check. Try again.',
    'not-librechat': 'This address did not return a LibreChat server configuration.',
    unreachable: 'Could not reach that server. Check the address and your network.',
    'storage-error': 'The connection could not be saved on this device. Try again.',
  },
};

const simplifiedChineseCopy: SetupCopy = {
  language: navigator.language,
  pageTitle: '连接服务器 · Agent Platform',
  heading: '连接到你的服务器',
  description: '将此桌面应用连接到组织的 LibreChat 服务器。账户和 AI 服务仍由该服务器管理。',
  addressLabel: '服务器地址',
  addressPlaceholder: 'https://ai.example.com',
  connect: '连接服务器',
  connecting: '正在连接…',
  connected: (serverUrl) => `已连接到 ${serverUrl}`,
  opening: '正在打开 Agent Platform…',
  footer: '请输入组织提供的服务器地址。',
  submissionError: '桌面应用无法完成连接，请重试。',
  errors: {
    'invalid-address': '请输入有效的 HTTP 或 HTTPS 服务器地址。',
    'server-error': '服务器未能完成连接检查，请重试。',
    'not-librechat': '此地址未返回 LibreChat 服务器配置。',
    unreachable: '无法连接到服务器，请检查地址和网络。',
    'storage-error': '无法在此设备保存连接设置，请重试。',
  },
};

const copy = navigator.language.toLowerCase().startsWith('zh')
  ? simplifiedChineseCopy
  : englishCopy;

declare global {
  interface Window {
    desktopShell: DesktopShellAPI;
  }
}

const form = document.querySelector<HTMLFormElement>('#connection-form');
const input = document.querySelector<HTMLInputElement>('#server-url');
const button = document.querySelector<HTMLButtonElement>('#connect-button');
const message = document.querySelector<HTMLParagraphElement>('#connection-message');
const heading = document.querySelector<HTMLHeadingElement>('#setup-heading');
const description = document.querySelector<HTMLParagraphElement>('#setup-description');
const addressLabel = document.querySelector<HTMLLabelElement>('#setup-label');
const footer = document.querySelector<HTMLElement>('#setup-footer');

if (
  !form ||
  !input ||
  !button ||
  !message ||
  !heading ||
  !description ||
  !addressLabel ||
  !footer
) {
  throw new Error('The server connection form is incomplete.');
}

document.documentElement.lang = copy.language;
document.title = copy.pageTitle;
heading.textContent = copy.heading;
description.textContent = copy.description;
addressLabel.textContent = copy.addressLabel;
input.placeholder = copy.addressPlaceholder;
button.textContent = copy.connect;
footer.textContent = copy.footer;

void window.desktopShell.getServerUrl().then((serverUrl) => {
  if (serverUrl) {
    input.value = serverUrl;
  }
  input.focus();
  input.select();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = copy.connecting;
  message.textContent = '';
  message.removeAttribute('data-state');

  let result: ConnectionResult;
  try {
    result = await window.desktopShell.connectToServer(input.value);
  } catch {
    result = {
      ok: false,
      code: 'unreachable',
    };
  }

  if (result.ok) {
    message.dataset.state = 'success';
    message.textContent = copy.connected(result.serverUrl);
    button.textContent = copy.opening;
    if (result.closeSettingsWindow) {
      window.close();
      return;
    }
    window.location.replace('/');
    return;
  }

  message.textContent = copy.errors[result.code] ?? copy.submissionError;
  button.disabled = false;
  button.textContent = copy.connect;
});
