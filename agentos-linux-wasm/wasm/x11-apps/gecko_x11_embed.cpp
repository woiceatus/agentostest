/*
 * gecko_x11_embed — glue between rebuilt Gecko (HeyPuter/firefox headless
 * embed APIs) and the firefox_x11_bridge X11 client.
 *
 * This file is compiled/linked only after libxul.so exists. Until then the
 * bridge uses weak stubs and shows a placeholder window on the JS XServer.
 *
 * Expected Gecko symbols (from gecko.js embed-* when linked):
 *   xul_init / paint / input hooks — names will be wired to the exact
 *   embed-xul.cpp exports once the engine build completes.
 */
#include <stdint.h>
#include <stdio.h>

extern "C" {

/* Declared weak in firefox_x11_bridge.c; strong definitions here when linked. */
int gecko_x11_embed_start(int w, int h) {
  fprintf(stderr, "gecko_x11_embed_start(%d,%d): not yet bound to libxul paint path\n", w, h);
  /* Return failure so the bridge keeps the placeholder until real bind. */
  (void)w;
  (void)h;
  return -1;
}

void gecko_x11_embed_pump(void) {}

void gecko_x11_embed_pointer(int x, int y, int buttons, int pressed) {
  (void)x;
  (void)y;
  (void)buttons;
  (void)pressed;
}

void gecko_x11_embed_key(int keycode, int pressed) {
  (void)keycode;
  (void)pressed;
}

void gecko_x11_embed_stop(void) {}

}
