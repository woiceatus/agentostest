/**
 * Emscripten JS library: web shell for Aurora Files → Terminal
 * (replaces Unix openpty/fork which cannot run in the browser).
 *
 * Host sets Module.auroraShell = { spawn, write, read, poll, resize, close }
 * where spawn(cwd:string, cols, rows) -> id, and the rest take id.
 */
mergeInto(LibraryManager.library, {
  shell_js_spawn: function (cwdPtr, cwdLen, cols, rows) {
    if (!Module.auroraShell || typeof Module.auroraShell.spawn !== "function") return -1;
    const cwd = cwdLen > 0 ? UTF8ToString(cwdPtr, cwdLen) : "/home/web_user";
    return Module.auroraShell.spawn(cwd, cols | 0, rows | 0) | 0;
  },

  shell_js_write: function (id, ptr, len) {
    if (!Module.auroraShell || typeof Module.auroraShell.write !== "function") return -1;
    if (len <= 0) return 0;
    const bytes = HEAPU8.subarray(ptr, ptr + len);
    return Module.auroraShell.write(id | 0, new Uint8Array(bytes)) | 0;
  },

  shell_js_read: function (id, ptr, maxlen) {
    if (!Module.auroraShell || typeof Module.auroraShell.read !== "function") return 0;
    if (maxlen <= 0) return 0;
    const dest = HEAPU8.subarray(ptr, ptr + maxlen);
    return Module.auroraShell.read(id | 0, dest) | 0;
  },

  shell_js_poll: function (id) {
    if (!Module.auroraShell || typeof Module.auroraShell.poll !== "function") return 0;
    return Module.auroraShell.poll(id | 0) | 0;
  },

  shell_js_resize: function (id, cols, rows) {
    if (!Module.auroraShell || typeof Module.auroraShell.resize !== "function") return -1;
    Module.auroraShell.resize(id | 0, cols | 0, rows | 0);
    return 0;
  },

  shell_js_close: function (id) {
    if (!Module.auroraShell || typeof Module.auroraShell.close !== "function") return;
    Module.auroraShell.close(id | 0);
  },
});
