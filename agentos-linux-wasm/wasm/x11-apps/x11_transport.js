/**
 * Emscripten JS library: byte transport between a WASM X11 client and the
 * in-tab JS XServer (via createStreamPair duplex).
 *
 * The host sets Module.x11Transport = { write(Uint8Array), read(Uint8Array)->n, poll()->n }
 * before calling main / xdemo_init.
 */
mergeInto(LibraryManager.library, {
  x11_js_write: function (ptr, len) {
    if (!Module.x11Transport || typeof Module.x11Transport.write !== "function") return -1;
    if (len <= 0) return 0;
    const bytes = HEAPU8.subarray(ptr, ptr + len);
    // Copy — stream pair delivery is async; WASM buffer may be reused.
    Module.x11Transport.write(new Uint8Array(bytes));
    return len;
  },

  x11_js_read: function (ptr, maxlen) {
    if (!Module.x11Transport || typeof Module.x11Transport.read !== "function") return 0;
    if (maxlen <= 0) return 0;
    const dest = HEAPU8.subarray(ptr, ptr + maxlen);
    return Module.x11Transport.read(dest) | 0;
  },

  x11_js_poll: function () {
    if (!Module.x11Transport || typeof Module.x11Transport.poll !== "function") return 0;
    return Module.x11Transport.poll() | 0;
  },

  x11_js_log: function (ptr) {
    if (typeof Module.print === "function") {
      Module.print(UTF8ToString(ptr));
    } else {
      console.log("[x11-app]", UTF8ToString(ptr));
    }
  },
});
