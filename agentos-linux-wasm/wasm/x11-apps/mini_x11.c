#include "mini_x11.h"
#include <string.h>

static void put16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)(v >> 8);
}
static void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)((v >> 8) & 0xff);
  p[2] = (uint8_t)((v >> 16) & 0xff);
  p[3] = (uint8_t)((v >> 24) & 0xff);
}
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int send_all(const uint8_t *data, int len) {
  int off = 0;
  while (off < len) {
    int n = x11_js_write(data + off, len - off);
    if (n <= 0) return -1;
    off += n;
  }
  return 0;
}

static int request(XConn *c, uint8_t *buf, int len) {
  /* length field is in 4-byte units at offset 2 (uint16), includes padding */
  int padded = (len + 3) & ~3;
  put16(buf + 2, (uint16_t)(padded / 4));
  while (len < padded) buf[len++] = 0;
  c->seq++;
  return send_all(buf, len);
}

int x_flush_read(XConn *c) {
  while (x11_js_poll() > 0 && c->in_len < (int)sizeof(c->inbuf)) {
    int n = x11_js_read(c->inbuf + c->in_len, (int)sizeof(c->inbuf) - c->in_len);
    if (n <= 0) break;
    c->in_len += n;
  }
  return c->in_len;
}

uint32_t x_new_id(XConn *c) {
  uint32_t id = c->resource_base | (c->next_id & c->resource_mask);
  c->next_id++;
  return id;
}

int x_connect(XConn *c) {
  memset(c, 0, sizeof(*c));
  uint8_t setup[12];
  memset(setup, 0, sizeof setup);
  setup[0] = 'l'; /* little-endian */
  put16(setup + 2, 11);
  put16(setup + 4, 0);
  /* auth name/data lengths = 0 */
  if (send_all(setup, 12) != 0) return -1;

  /* Wait for setup reply (at least 8 bytes header). */
  for (int attempt = 0; attempt < 2000; attempt++) {
    x_flush_read(c);
    if (c->in_len >= 8) break;
  }
  if (c->in_len < 8) {
    x11_js_log("X setup: no reply");
    return -1;
  }
  if (c->inbuf[0] != 1) {
    x11_js_log("X setup failed");
    return -1;
  }
  uint16_t extra = get16(c->inbuf + 6);
  int need = 8 + (int)extra * 4;
  for (int attempt = 0; attempt < 2000 && c->in_len < need; attempt++) x_flush_read(c);
  if (c->in_len < need) {
    x11_js_log("X setup truncated");
    return -1;
  }

  /* Parse connection setup success (LSBFirst). */
  const uint8_t *p = c->inbuf;
  /* skip: status, unused, major, minor, add-len already used */
  /* release 4, res_id_base 4, res_id_mask 4, motion_buffer 4 */
  /* vendor_len 2, max_req 2, num_screens 1, ... */
  int vendor_len = get16(p + 24);
  c->resource_base = get32(p + 12);
  c->resource_mask = get32(p + 16);
  int num_formats = p[29];
  /* After fixed 40-byte header comes vendor string (pad4), then formats, then screens */
  int off = 40;
  off += (vendor_len + 3) & ~3;
  off += num_formats * 8;
  if (off + 40 > need) {
    x11_js_log("X setup screen missing");
    return -1;
  }
  const uint8_t *screen = p + off;
  c->root = get32(screen + 0);
  c->screen_w = (int)get16(screen + 20);
  c->screen_h = (int)get16(screen + 22);
  c->root_visual = get32(screen + 32);
  c->root_depth = screen[38];

  /* Consume setup from input buffer. */
  memmove(c->inbuf, c->inbuf + need, (size_t)(c->in_len - need));
  c->in_len -= need;
  c->connected = 1;
  c->next_id = 1;
  c->seq = 0;
  x11_js_log("X11 connected to in-tab XServer");
  return 0;
}

int x_next_event(XConn *c, XEvent *ev) {
  x_flush_read(c);
  if (c->in_len < 32) return 0;
  memcpy(ev->raw, c->inbuf, 32);
  uint8_t code = c->inbuf[0];
  if (code == 0) {
    /* error — skip */
    memmove(c->inbuf, c->inbuf + 32, (size_t)(c->in_len - 32));
    c->in_len -= 32;
    return 0;
  }
  if (code == 1) {
    /* reply — skip generic 32 + extra */
    uint32_t extra = get32(c->inbuf + 4);
    int total = 32 + (int)extra * 4;
    if (c->in_len < total) return 0;
    memmove(c->inbuf, c->inbuf + total, (size_t)(c->in_len - total));
    c->in_len -= total;
    return 0;
  }
  ev->type = (uint8_t)(code & 0x7f);
  ev->detail = c->inbuf[1];
  ev->seq = get16(c->inbuf + 2);
  ev->time = get32(c->inbuf + 4);
  ev->window = get32(c->inbuf + 8);
  if (ev->type == X_Expose) {
    ev->window = get32(c->inbuf + 4);
    ev->x = (int16_t)get16(c->inbuf + 8);
    ev->y = (int16_t)get16(c->inbuf + 10);
    ev->width = get16(c->inbuf + 12);
    ev->height = get16(c->inbuf + 14);
  } else if (ev->type == X_ButtonPress || ev->type == X_ButtonRelease ||
             ev->type == X_MotionNotify || ev->type == X_KeyPress || ev->type == X_KeyRelease) {
    ev->window = get32(c->inbuf + 12); /* event window */
    ev->x = (int16_t)get16(c->inbuf + 24);
    ev->y = (int16_t)get16(c->inbuf + 26);
  }
  memmove(c->inbuf, c->inbuf + 32, (size_t)(c->in_len - 32));
  c->in_len -= 32;
  return 1;
}

void x_create_window(XConn *c, uint32_t wid, int x, int y, int w, int h,
                     uint32_t bg, uint32_t event_mask) {
  uint8_t b[48];
  memset(b, 0, sizeof b);
  b[0] = 1; /* CreateWindow */
  b[1] = (uint8_t)c->root_depth;
  put32(b + 4, wid);
  put32(b + 8, c->root);
  put16(b + 12, (uint16_t)x);
  put16(b + 14, (uint16_t)y);
  put16(b + 16, (uint16_t)w);
  put16(b + 18, (uint16_t)h);
  put16(b + 20, 1); /* border */
  put16(b + 22, 1); /* InputOutput */
  put32(b + 24, 0); /* CopyFromParent visual → use 0 / CopyFromParent */
  /* value mask: background-pixel | border-pixel | event-mask */
  uint32_t mask = 0x00000002 | 0x00000008 | 0x00000800;
  put32(b + 28, mask);
  put32(b + 32, bg);
  put32(b + 36, 0x000000); /* border pixel */
  put32(b + 40, event_mask);
  request(c, b, 44);
}

void x_map_window(XConn *c, uint32_t wid) {
  uint8_t b[8];
  memset(b, 0, sizeof b);
  b[0] = 8; /* MapWindow */
  put32(b + 4, wid);
  request(c, b, 8);
}

void x_create_gc(XConn *c, uint32_t gc, uint32_t drawable, uint32_t fg, uint32_t bg) {
  uint8_t b[24];
  memset(b, 0, sizeof b);
  b[0] = 55; /* CreateGC */
  put32(b + 4, gc);
  put32(b + 8, drawable);
  uint32_t mask = 0x00000004 | 0x00000008; /* foreground | background */
  put32(b + 12, mask);
  put32(b + 16, fg);
  put32(b + 20, bg);
  request(c, b, 24);
}

void x_change_gc_fg(XConn *c, uint32_t gc, uint32_t fg) {
  uint8_t b[16];
  memset(b, 0, sizeof b);
  b[0] = 56; /* ChangeGC */
  put32(b + 4, gc);
  put32(b + 8, 0x00000004);
  put32(b + 12, fg);
  request(c, b, 16);
}

void x_poly_fill_rect(XConn *c, uint32_t drawable, uint32_t gc, int x, int y, int w, int h) {
  uint8_t b[20];
  memset(b, 0, sizeof b);
  b[0] = 70; /* PolyFillRectangle */
  put32(b + 4, drawable);
  put32(b + 8, gc);
  put16(b + 12, (uint16_t)x);
  put16(b + 14, (uint16_t)y);
  put16(b + 16, (uint16_t)w);
  put16(b + 18, (uint16_t)h);
  request(c, b, 20);
}

void x_image_text8(XConn *c, uint32_t drawable, uint32_t gc, int x, int y, const char *text) {
  int n = (int)strlen(text);
  if (n > 255) n = 255;
  uint8_t b[16 + 256];
  memset(b, 0, sizeof b);
  b[0] = 76; /* ImageText8 */
  b[1] = (uint8_t)n;
  put32(b + 4, drawable);
  put32(b + 8, gc);
  put16(b + 12, (uint16_t)x);
  put16(b + 14, (uint16_t)y);
  memcpy(b + 16, text, (size_t)n);
  request(c, b, 16 + n);
}

void x_clear_area(XConn *c, uint32_t wid, int x, int y, int w, int h, int exposures) {
  uint8_t b[16];
  memset(b, 0, sizeof b);
  b[0] = 61; /* ClearArea */
  b[1] = exposures ? 1 : 0;
  put32(b + 4, wid);
  put16(b + 8, (uint16_t)x);
  put16(b + 10, (uint16_t)y);
  put16(b + 12, (uint16_t)w);
  put16(b + 14, (uint16_t)h);
  request(c, b, 16);
}

void x_put_image_zpixmap32(XConn *c, uint32_t drawable, uint32_t gc,
                           int dst_x, int dst_y, int width, int height,
                           const uint32_t *pixels) {
  /* Tile into strips so we stay under the default max-request without BIG-REQUESTS. */
  const int max_rows = 16;
  uint8_t header[24];
  for (int y0 = 0; y0 < height; y0 += max_rows) {
    int rows = height - y0;
    if (rows > max_rows) rows = max_rows;
    int data_bytes = width * rows * 4;
    int total = 24 + data_bytes;
    int padded = (total + 3) & ~3;
    /* Build request: opcode + format + length + fields + pixels */
    static uint8_t buf[24 + 960 * 16 * 4 + 4];
    if (padded > (int)sizeof(buf)) {
      /* Fallback: even smaller strips */
      rows = 4;
      data_bytes = width * rows * 4;
      total = 24 + data_bytes;
      padded = (total + 3) & ~3;
      if (padded > (int)sizeof(buf)) return;
    }
    memset(buf, 0, (size_t)padded);
    buf[0] = 72; /* PutImage */
    buf[1] = 2;  /* ZPixmap */
    put16(buf + 2, (uint16_t)(padded / 4));
    put32(buf + 4, drawable);
    put32(buf + 8, gc);
    put16(buf + 12, (uint16_t)width);
    put16(buf + 14, (uint16_t)rows);
    put16(buf + 16, (uint16_t)dst_x);
    put16(buf + 18, (uint16_t)(dst_y + y0));
    buf[20] = 0; /* leftPad */
    buf[21] = 24; /* depth — JS server accepts 24/32 into depth-24 drawables */
    memcpy(buf + 24, pixels + (size_t)y0 * (size_t)width, (size_t)data_bytes);
    c->seq++;
    if (send_all(buf, padded) != 0) return;
  }
}
