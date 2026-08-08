/* Minimal X11 clock client — draws via real X protocol into JS XServer. */

#include "mini_x11.h"
#include <stdio.h>
#include <string.h>

#define WIN_W 280
#define WIN_H 120

static XConn conn;
static uint32_t win, gc_bg, gc_fg, gc_accent;
static int ready;
static int tick;
static char last_text[64];

static void paint(const char *text) {
  x_change_gc_fg(&conn, gc_bg, 0x101820);
  x_poly_fill_rect(&conn, win, gc_bg, 0, 0, WIN_W, WIN_H);
  x_change_gc_fg(&conn, gc_accent, 0xf6be52);
  x_poly_fill_rect(&conn, win, gc_accent, 0, 0, WIN_W, 28);
  x_change_gc_fg(&conn, gc_fg, 0x102018);
  x_image_text8(&conn, win, gc_fg, 12, 19, "xclock-demo (X11 WASM)");
  x_change_gc_fg(&conn, gc_fg, 0xe8eef7);
  x_image_text8(&conn, win, gc_fg, 36, 72, text);
  x_change_gc_fg(&conn, gc_fg, 0x7f8b99);
  x_image_text8(&conn, win, gc_fg, 20, 100, "compose() pixels from XServer");
}

__attribute__((used, export_name("xclock_start")))
int xclock_start(void) {
  if (x_connect(&conn) != 0) return 0;
  win = x_new_id(&conn);
  gc_bg = x_new_id(&conn);
  gc_fg = x_new_id(&conn);
  gc_accent = x_new_id(&conn);
  uint32_t mask = 0x8000 | 0x20000; /* Exposure | StructureNotify */
  x_create_window(&conn, win, 520, 80, WIN_W, WIN_H, 0x101820, mask);
  x_create_gc(&conn, gc_bg, win, 0x101820, 0x101820);
  x_create_gc(&conn, gc_fg, win, 0xe8eef7, 0x101820);
  x_create_gc(&conn, gc_accent, win, 0xf6be52, 0x101820);
  x_map_window(&conn, win);
  ready = 1;
  snprintf(last_text, sizeof last_text, "tick 0");
  x11_js_log("xclock-demo mapped");
  return 1;
}

__attribute__((used, export_name("xclock_pump")))
int xclock_pump(int now_ms) {
  if (!ready) return 0;
  XEvent ev;
  while (x_next_event(&conn, &ev)) {
    if (ev.type == X_Expose) paint(last_text);
  }
  int t = now_ms / 1000;
  if (t != tick || last_text[0] == 0) {
    tick = t;
    int h = (t / 3600) % 24;
    int m = (t / 60) % 60;
    int s = t % 60;
    snprintf(last_text, sizeof last_text, "  %02d:%02d:%02d", h, m, s);
    paint(last_text);
    return 1;
  }
  return 0;
}

__attribute__((used, export_name("xclock_is_running")))
int xclock_is_running(void) { return ready; }
