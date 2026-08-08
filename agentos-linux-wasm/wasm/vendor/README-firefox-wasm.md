# Firefox → X11 WASM rebuild

Clone Puter’s orchestration tree (source build only — not their prebuilt demo):

```bash
cd wasm/vendor
git clone --depth 1 https://github.com/HeyPuter/firefox-wasm.git firefox-wasm
cd firefox-wasm
make emsdk && make firefox && make vendor && make build
```

Then see `docs/firefox-x11-wasm.md` and `scripts/build-firefox-x11-bridge.sh`.

The firefox/ checkout, emsdk/, and objdirs are gitignored (multi‑GB).
