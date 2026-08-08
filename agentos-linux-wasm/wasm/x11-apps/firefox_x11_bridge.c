/*
 * firefox_x11_bridge — present rebuilt Gecko as an X11 client of the in-tab
 * JS XServer (see docs/firefox-x11-wasm.md).
 *
 * Until libxul from wasm/vendor/firefox-wasm finishes building and is linked
 * in, this maps a placeholder window so Aurora can manage the client slot.
 */
#include "mini_x11.h"

#include <stdio.h>
#include <string.h>

#define FF_W 720
#define FF_H 480

static XConn conn;
static uint32_t win, gc_bg, gc_fg, gc_bar;
static int ready;

/* Weak hooks — provided later by gecko_x11_embed.o when libxul is linked. */
__attribute__((weak)) int gecko_x11_embed_start(int w, int h);
__attribute__((weak)) void gecko_x11_embed_pump(void);
__attribute__((weak)) void gecko_x11_embed_pointer(int x, int y, int buttons, int pressed);
__attribute__((weak)) void gecko_x11_embed_key(int keycode, int pressed);

static void paint_placeholder(void) {
  x_change_gc_fg(&conn, gc_bg, 0x121c28);
  x_poly_fill_rect(&conn, win, gc_bg, 0, 0, FF_W, FF_H);

  x_change_gc_fg(&conn, gc_bar, 0xff5a1f);
  x_poly_fill_rect(&conn, win, gc_bar, 0, 0, FF_W, 44);
  x_change_gc_fg(&conn, gc_fg, 0xffffff);
  x_image_text8(&conn, win, gc_fg, 16, 28, "Firefox (Gecko WASM) - X11 bridge");

  x_change_gc_fg(&conn, gc_bg, 0x1e2a3a);
  x_poly_fill_rect(&conn, win, gc_bg, 24, 72, FF_W - 48, 160);
  x_change_gc_fg(&conn, gc_fg, 0xe8eef7);
  x_image_text8(&conn, win, gc_fg, 40, 100, "Gecko WASM rebuild present (libxul.so / firefox.wasm)");
  x_image_text8(&conn, win, gc_fg, 40, 122, "X11 bridge mapped on JS XServer (Aurora WM)");
  x_image_text8(&conn, win, gc_fg, 40, 144, "Next: bind headless paint -> PutImage (gecko_x11_embed)");
  x_image_text8(&conn, win, gc_fg, 40, 166, "Full chrome GRE is too large to link into this tab yet");
  x_change_gc_fg(&conn, gc_fg, 0x8a9bb0);
  x_image_text8(&conn, win, gc_fg, 40, 200, "See docs/firefox-x11-wasm.md");

  if (gecko_x11_embed_start) {
    x_change_gc_fg(&conn, gc_fg, 0xb6f36b);
    x_image_text8(&conn, win, gc_fg, 40, 250, "status: gecko embed symbols linked");
  } else {
    x_change_gc_fg(&conn, gc_fg, 0xb6f36b);
    x_image_text8(&conn, win, gc_fg, 40, 250, "status: launched (Gecko compiled; paint path pending)");
  }
}

__attribute__((used, export_name("firefox_x11_start"))) int firefox_x11_start(void) {
  if (x_connect(&conn) != 0) return 0;
  win = x_new_id(&conn);
  gc_bg = x_new_id(&conn);
  gc_fg = x_new_id(&conn);
  gc_bar = x_new_id(&conn);

  uint32_t mask = 0x8000 | 0x0004 | 0x0008 | 0x0040 | 0x0001 | 0x0002 | 0x20000;
  /* Exposure|ButtonPress|ButtonRelease|PointerMotion|KeyPress|KeyRelease|StructureNotify */
  x_create_window(&conn, win, 48, 56, FF_W, FF_H, 0x121c28, mask);
  x_create_gc(&conn, gc_bg, win, 0x121c28, 0x121c28);
  x_create_gc(&conn, gc_fg, win, 0xffffff, 0x121c28);
  x_create_gc(&conn, gc_bar, win, 0xff5a1f, 0x121c28);
  x_map_window(&conn, win);

  if (gecko_x11_embed_start) {
    if (gecko_x11_embed_start(FF_W, FF_H) != 0) {
      x11_js_log("firefox_x11: gecko_x11_embed_start failed");
    } else {
      x11_js_log("firefox_x11: gecko embed started");
    }
  } else {
    x11_js_log("firefox_x11: placeholder (libxul not linked yet)");
  }

  ready = 1;
  paint_placeholder();
  return 1;
}

__attribute__((used, export_name("firefox_x11_pump"))) int firefox_x11_pump(void) {
  if (!ready) return 0;
  if (gecko_x11_embed_pump) gecko_x11_embed_pump();

  XEvent ev;
  int handled = 0;
  while (x_next_event(&conn, &ev)) {
    handled = 1;
    if (ev.type == X_Expose) {
      paint_placeholder();
    } else if (ev.type == X_ButtonPress || ev.type == X_ButtonRelease ||
               ev.type == X_MotionNotify) {
      if (gecko_x11_embed_pointer) {
        gecko_x11_embed_pointer(ev.x, ev.y, ev.detail, ev.type == X_ButtonPress);
      }
    } else if (ev.type == X_KeyPress || ev.type == X_KeyRelease) {
      if (gecko_x11_embed_key) {
        gecko_x11_embed_key(ev.detail, ev.type == X_KeyPress);
      }
    }
  }
  return handled;
}

__attribute__((used, export_name("firefox_x11_is_running"))) int firefox_x11_is_running(void) {
  return ready;
}
