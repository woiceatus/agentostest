import { Buffer as BrowserBuffer } from "buffer";

// The bundled `x11` client library reads Node globals (`Buffer`, `setImmediate`)
// while its modules are being evaluated. ES module imports are evaluated before
// the importing module's body runs, so these globals must be installed by a
// side-effect module that is imported *before* `x11`, not from the body of the
// module that also imports `x11`.
type GlobalBrowser = typeof globalThis & {
  Buffer?: typeof BrowserBuffer;
  setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => number;
};

const browserGlobal = globalThis as GlobalBrowser;
if (!browserGlobal.Buffer) browserGlobal.Buffer = BrowserBuffer;
if (typeof window !== "undefined" && !browserGlobal.setImmediate) {
  browserGlobal.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    window.setTimeout(callback, 0, ...args)) as GlobalBrowser["setImmediate"];
}
