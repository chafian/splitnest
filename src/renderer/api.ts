import type { AppApi } from '../shared/ipc';

declare global {
  interface Window {
    appApi: AppApi;
  }
}

export const api: AppApi = window.appApi;
