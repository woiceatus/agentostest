/**
 * Emscripten JS library: HTTP(S) fetch for original NetSurf via AgentOS proxy.
 * Browser does TLS; NetSurf browser core is unchanged.
 */
mergeInto(LibraryManager.library, {
  agentos_js_http_fetch__deps: ["$Asyncify", "malloc", "free"],
  agentos_js_http_fetch: function (
    urlPtr,
    methodPtr,
    bodyPtr,
    bodyLen,
    outStatusPtr,
    outFinalUrlPtrPtr,
    outBodyPtrPtr,
    outBodyLenPtr,
  ) {
    return Asyncify.handleAsync(async () => {
      const writeI32 = (ptr, value) => {
        HEAP32[ptr >> 2] = value | 0;
      };
      try {
        const url = UTF8ToString(urlPtr);
        const method = UTF8ToString(methodPtr) || "GET";
        let body = null;
        if (bodyPtr && bodyLen > 0) {
          body = UTF8ToString(bodyPtr, bodyLen);
        }
        const response = await fetch("/__agentos/proxy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "request",
            id: `netsurf-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            url,
            method,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) NetSurf/3.11 AgentOS",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              ...(method === "POST"
                ? { "Content-Type": "application/x-www-form-urlencoded" }
                : {}),
            },
            body,
          }),
        });
        if (!response.ok) {
          let message = `proxy HTTP ${response.status}`;
          try {
            const payload = JSON.parse(await response.text());
            if (payload && payload.error) message = payload.error;
          } catch (_) {
            /* keep status */
          }
          throw new Error(message);
        }
        const status = Number(response.headers.get("x-agentos-status") || "0");
        const finalUrl = response.headers.get("x-agentos-url") || url;
        let contentType = "text/html; charset=utf-8";
        try {
          const hdrJson = response.headers.get("x-agentos-response-headers");
          if (hdrJson) {
            const hdrs = JSON.parse(hdrJson);
            if (hdrs && hdrs["content-type"]) contentType = hdrs["content-type"];
            else if (hdrs && hdrs["Content-Type"]) contentType = hdrs["Content-Type"];
          }
        } catch (_) {
          /* keep default */
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const bodyMem = _malloc(bytes.length + 1);
        if (!bodyMem) throw new Error("oom body");
        HEAPU8.set(bytes, bodyMem);
        HEAPU8[bodyMem + bytes.length] = 0;

        /* Pack final URL + content-type as "url\0content-type" for C side. */
        const meta = `${finalUrl}\0${contentType}`;
        const metaBytes = lengthBytesUTF8(meta) + 1;
        const metaMem = _malloc(metaBytes);
        if (!metaMem) {
          _free(bodyMem);
          throw new Error("oom meta");
        }
        stringToUTF8(meta, metaMem, metaBytes);

        writeI32(outStatusPtr, status);
        writeI32(outFinalUrlPtrPtr, metaMem);
        writeI32(outBodyPtrPtr, bodyMem);
        writeI32(outBodyLenPtr, bytes.length);
        return 0;
      } catch (err) {
        const msg = err && err.message ? String(err.message) : "fetch failed";
        const metaBytes = lengthBytesUTF8(msg) + 1;
        const metaMem = _malloc(metaBytes);
        if (metaMem) stringToUTF8(msg, metaMem, metaBytes);
        writeI32(outStatusPtr, 0);
        writeI32(outFinalUrlPtrPtr, metaMem || 0);
        writeI32(outBodyPtrPtr, 0);
        writeI32(outBodyLenPtr, 0);
        return -1;
      }
    });
  },
});
