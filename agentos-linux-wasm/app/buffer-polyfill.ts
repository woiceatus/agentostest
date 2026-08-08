import { Buffer as BrowserBuffer } from "buffer";

type GlobalBrowser = typeof globalThis & {
  Buffer?: typeof BrowserBuffer;
  setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => number;
  process?: { env: Record<string, string | undefined> };
};

const browserGlobal = globalThis as GlobalBrowser;

if (!browserGlobal.Buffer) {
  browserGlobal.Buffer = BrowserBuffer;
}

if (!browserGlobal.setImmediate) {
  browserGlobal.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    window.setTimeout(callback, 0, ...args)) as GlobalBrowser["setImmediate"];
}

if (!browserGlobal.process) {
  browserGlobal.process = { env: {} };
}
