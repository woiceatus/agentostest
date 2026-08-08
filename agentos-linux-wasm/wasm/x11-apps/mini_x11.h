/* Minimal X11 wire-protocol client for AgentOS in-tab XServer.
 * Speaks real X11 (not a canvas fake). Transport is JS-bridged.
 */
#ifndef AGENTOS_MINI_X11_H
#define AGENTOS_MINI_X11_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int x11_js_write(const void *data, int len);
int x11_js_read(void *buf, int maxlen);
int x11_js_poll(void);
void x11_js_log(const char *msg);

typedef struct XConn {
  uint32_t root;
  uint32_t root_visual;
  uint16_t root_depth;
  uint16_t seq;
  uint32_t resource_base;
  uint32_t resource_mask;
  uint32_t next_id;
  uint8_t inbuf[65536];
  int in_len;
  int screen_w;
  int screen_h;
  int connected;
} XConn;

typedef struct XEvent {
  uint8_t type;
  uint8_t detail;
  uint16_t seq;
  uint32_t window;
  int16_t x, y;
  uint16_t width, height;
  uint32_t time;
  uint8_t raw[32];
} XEvent;

enum {
  X_KeyPress = 2,
  X_KeyRelease = 3,
  X_ButtonPress = 4,
  X_ButtonRelease = 5,
  X_MotionNotify = 6,
  X_Expose = 12,
  X_ConfigureNotify = 22,
  X_ClientMessage = 33,
};

int x_connect(XConn *c);
uint32_t x_new_id(XConn *c);
int x_flush_read(XConn *c);
int x_next_event(XConn *c, XEvent *ev);

void x_create_window(XConn *c, uint32_t wid, int x, int y, int w, int h,
                     uint32_t bg, uint32_t event_mask);
void x_map_window(XConn *c, uint32_t wid);
void x_create_gc(XConn *c, uint32_t gc, uint32_t drawable, uint32_t fg, uint32_t bg);
void x_change_gc_fg(XConn *c, uint32_t gc, uint32_t fg);
void x_poly_fill_rect(XConn *c, uint32_t drawable, uint32_t gc, int x, int y, int w, int h);
void x_image_text8(XConn *c, uint32_t drawable, uint32_t gc, int x, int y, const char *text);
void x_clear_area(XConn *c, uint32_t wid, int x, int y, int w, int h, int exposures);

#ifdef __cplusplus
}
#endif
#endif
