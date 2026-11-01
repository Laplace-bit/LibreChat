/// <reference types="vite/client" />

import 'react';

declare global {
  namespace React {
    // The existing generic parameter is required to merge this global interface.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface HTMLAttributes<T> {
      /** React 18 serializes this unknown HTML boolean attribute from its empty-string form. */
      inert?: '' | undefined;
    }
  }

  interface ImportMetaEnv {
    readonly VITE_ENABLE_LOGGER: string;
    readonly VITE_LOGGER_FILTER: string;
    readonly VITE_FLAT_THREAD: string;
    // Add other env variables here
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
