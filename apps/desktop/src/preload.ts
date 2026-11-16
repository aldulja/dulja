import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type DuljaBridge } from "./bridge-types";

/**
 * spec:1284 — "all privileged operations behind a typed `contextBridge` API, never raw Node in the
 * renderer". Every member is an explicit function over a named channel: no `ipcRenderer`, no `invoke`
 * with a caller-supplied channel name, nothing generic.
 */
const bridge: DuljaBridge = {
  auth: {
    get: (key) => ipcRenderer.invoke(CHANNELS.authGet, key),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.authSet, key, value),
    remove: (key) => ipcRenderer.invoke(CHANNELS.authRemove, key),
  },
  app: {
    version: () => ipcRenderer.invoke(CHANNELS.appVersion),
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.appCheckForUpdates),
  },
  print: {
    toPdf: (options) => ipcRenderer.invoke(CHANNELS.printToPdf, options),
  },
};

contextBridge.exposeInMainWorld("dulja", bridge);
