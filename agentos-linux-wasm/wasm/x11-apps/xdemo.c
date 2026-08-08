/* Real X11 client demo for AgentOS.
 *
 * Speaks the X11 wire protocol to the in-tab JS XServer (node-x11).
 * Draws with PolyFillRectangle / ImageText8 — pixels come from the server
 * compose() path, not a fake DOM UI.
 */

#include "mini_x11.h"
#include <stdio.h>
#include <string.h>

#define WIN_W 420
#define WIN_H 300
#define BTN_X 140
#define BTN_Y 200
#define BTN_W 140
#define BTN_H 36

static XConn conn;
static uint32_t win, gc_bg, gc_fg, gc_btn, gc_btn_text;
static int toggled;
static int click_count;
static int ready;

static void paint(void) {
  /* Window chrome body */
  x_change_gc_fg(&conn, gc_bg, 0x1a2332);
  x_poly_fill_rect(&conn, win, gc_bg, 0, 0, WIN_W, WIN_H);

  /* Header bar */
  x_change_gc_fg(&conn, gc_bg, 0x2d6cdf);
  x_poly_fill_rect(&conn, win, gc_bg, 0, 0, WIN_W, 40);
  x_change_gc_fg(&conn, gc_fg, 0xffffff);
  x_image_text8(&conn, win, gc_fg, 16, 26, "xdemo - real X11 client (WASM)");

  /* Info panel */
  x_change_gc_fg(&conn, gc_bg, 0x243447);
  x_poly_fill_rect(&conn, win, gc_bg, 20, 60, WIN_W - 40, 110);
  x_change_gc_fg(&conn, gc_fg, 0xb6f36b);
  x_image_text8(&conn, win, gc_fg, 36, 88, "Protocol: X11 LE -> JS XServer");
  x_image_text8(&conn, win, gc_fg, 36, 108, "Drawing: PolyFillRectangle + ImageText8");
  x_image_text8(&conn, win, gc_fg, 36, 128, "Pixels: server.compose() root.raster");

  char line[64];
  snprintf(line, sizeof line, "Button clicks: %d  state: %s", click_count, toggled ? "ON" : "OFF");
  x_change_gc_fg(&conn, gc_fg, 0xe8eef7);
  x_image_text8(&conn, win, gc_fg, 36, 152, line);

  /* Interactive button */
  uint32_t btn_color = toggled ? 0x3dd68c : 0xe85d4c;
  x_change_gc_fg(&conn, gc_btn, btn_color);
  x_poly_fill_rect(&conn, win, gc_btn, BTN_X, BTN_Y, BTN_W, BTN_H);
  x_change_gc_fg(&conn, gc_btn_text, 0xffffff);
  x_image_text8(&conn, win, gc_btn_text, BTN_X + 28, BTN_Y + 23, toggled ? "Toggle: ON " : "Toggle: OFF");

  x_change_gc_fg(&conn, gc_fg, 0x8a9bb0);
  x_image_text8(&conn, win, gc_fg, 24, WIN_H - 20, "Click the button - events from X server");
}

/* Called from JS after Module.x11Transport is installed. */
__attribute__((used, export_name("xdemo_start")))
int xdemo_start(void) {
  if (x_connect(&conn) != 0) return 0;
  win = x_new_id(&conn);
  gc_bg = x_new_id(&conn);
  gc_fg = x_new_id(&conn);
  gc_btn = x_new_id(&conn);
  gc_btn_text = x_new_id(&conn);

  uint32_t mask = 0x8000 | 0x0004 | 0x20000; /* Exposure|ButtonPress|StructureNotify */
  /* Exposure=0x8000, ButtonPress=0x4, StructureNotify=0x20000 */
  x_create_window(&conn, win, 80, 60, WIN_W, WIN_H, 0x1a2332, mask);
  x_create_gc(&conn, gc_bg, win, 0x1a2332, 0x1a2332);
  x_create_gc(&conn, gc_fg, win, 0xffffff, 0x1a2332);
  x_create_gc(&conn, gc_btn, win, 0xe85d4c, 0x1a2332);
  x_create_gc(&conn, gc_btn_text, win, 0xffffff, 0xe85d4c);
  x_map_window(&conn, win);
  ready = 1;
  x11_js_log("xdemo mapped CreateWindow+MapWindow");
  return 1;
}

__attribute__((used, export_name("xdemo_pump")))
int xdemo_pump(void) {
  if (!ready) return 0;
  XEvent ev;
  int handled = 0;
  while (x_next_event(&conn, &ev)) {
    handled = 1;
    if (ev.type == X_Expose) {
      paint();
    } else if (ev.type == X_ButtonPress) {
      if (ev.x >= BTN_X && ev.x < BTN_X + BTN_W && ev.y >= BTN_Y && ev.y < BTN_Y + BTN_H) {
        toggled = !toggled;
        click_count++;
        paint();
      }
    }
  }
  return handled;
}

__attribute__((used, export_name("xdemo_is_running")))
int xdemo_is_running(void) { return ready; }
