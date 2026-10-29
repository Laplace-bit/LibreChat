import type { ConnectionResult, DesktopShellAPI } from './preload';

declare global {
  interface Window {
    desktopShell: DesktopShellAPI;
  }
}

const form = document.querySelector<HTMLFormElement>('#connection-form');
const input = document.querySelector<HTMLInputElement>('#server-url');
const button = document.querySelector<HTMLButtonElement>('#connect-button');
const message = document.querySelector<HTMLParagraphElement>('#connection-message');

if (!form || !input || !button || !message) {
  throw new Error('The server connection form is incomplete.');
}

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
  button.textContent = 'Connecting…';
  message.textContent = '';
  message.removeAttribute('data-state');

  let result: ConnectionResult;
  try {
    result = await window.desktopShell.connectToServer(input.value);
  } catch {
    result = {
      ok: false,
      message: 'The desktop app could not complete the connection. Try again.',
    };
  }

  if (result.ok) {
    message.dataset.state = 'success';
    message.textContent = `Connected to ${result.serverUrl}`;
    button.textContent = 'Opening Agent Platform…';
    if (result.closeSettingsWindow) {
      window.close();
      return;
    }
    window.location.replace('/');
    return;
  }

  message.textContent = result.message;
  button.disabled = false;
  button.textContent = 'Connect';
});
