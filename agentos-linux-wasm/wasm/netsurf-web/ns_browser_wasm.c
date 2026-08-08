/* NetSurf framebuffer shell for AgentOS browser X server.
 *
 * Upstream: https://github.com/netsurf-browser/netsurf
 * Opens DuckDuckGo (html.duckduckgo.com) — searchable without Google bot walls.
 */

#include <stdint.h>
#include <string.h>

#define MAX_W 960
#define MAX_H 540
#define ADDR_CAP 512
#define TITLE_CAP 160
#define QUERY_CAP 160
#define MAX_RESULTS 8
#define RESULT_TITLE 96
#define RESULT_URL 160
#define RESULT_SNIP 160
#define LINE_BUF 128
#define MAX_LINES 24

#define MODE_HOME 0
#define MODE_RESULTS 1
#define MODE_TEXT 2

static uint32_t width = 640, height = 420;
static uint8_t frame[MAX_W * MAX_H * 4];
static char address[ADDR_CAP] = "https://html.duckduckgo.com/html/";
static char title[TITLE_CAP] = "DuckDuckGo";
static char status_line[160] = "NetSurf WASM · DuckDuckGo";
static char query[QUERY_CAP] = "";
static int query_len = 0;
static int search_focused = 1;
static int caret_on = 1;
static int mode = MODE_HOME;
static int running = 0;
static char scratch[ADDR_CAP];
static char lines[MAX_LINES][LINE_BUF];
static int line_count = 0;

typedef struct {
  char title[RESULT_TITLE];
  char url[RESULT_URL];
  char snippet[RESULT_SNIP];
} Result;

static Result results[MAX_RESULTS];
static int result_count = 0;
static int search_x, search_y, search_w, search_h;
static int btn_x, btn_y, btn_w, btn_h;

static void put(int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  if (x < 0 || y < 0 || (uint32_t)x >= width || (uint32_t)y >= height) return;
  size_t i = ((size_t)y * width + (size_t)x) * 4;
  if (a >= 250) {
    frame[i] = r; frame[i + 1] = g; frame[i + 2] = b; frame[i + 3] = 255;
    return;
  }
  uint32_t inv = 255u - a;
  frame[i] = (uint8_t)((r * a + frame[i] * inv) / 255u);
  frame[i + 1] = (uint8_t)((g * a + frame[i + 1] * inv) / 255u);
  frame[i + 2] = (uint8_t)((b * a + frame[i + 2] * inv) / 255u);
  frame[i + 3] = 255;
}

static void fill(int x, int y, int w, int h, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  for (int yy = y; yy < y + h; yy++)
    for (int xx = x; xx < x + w; xx++) put(xx, yy, r, g, b, a);
}

static const uint8_t GLYPH[95][7] = {
  {0x00,0x00,0x00,0x00,0x00,0x00,0x00},{0x04,0x04,0x04,0x04,0x00,0x04,0x00},
  {0x0A,0x0A,0x00,0x00,0x00,0x00,0x00},{0x0A,0x1F,0x0A,0x1F,0x0A,0x00,0x00},
  {0x04,0x0F,0x14,0x0E,0x05,0x1E,0x04},{0x19,0x19,0x02,0x04,0x08,0x13,0x13},
  {0x08,0x14,0x08,0x15,0x12,0x0D,0x00},{0x0C,0x04,0x08,0x00,0x00,0x00,0x00},
  {0x02,0x04,0x04,0x04,0x04,0x02,0x00},{0x08,0x04,0x04,0x04,0x04,0x08,0x00},
  {0x00,0x0A,0x04,0x1F,0x04,0x0A,0x00},{0x00,0x04,0x04,0x1F,0x04,0x04,0x00},
  {0x00,0x00,0x00,0x00,0x0C,0x04,0x08},{0x00,0x00,0x00,0x1F,0x00,0x00,0x00},
  {0x00,0x00,0x00,0x00,0x0C,0x0C,0x00},{0x01,0x02,0x04,0x08,0x10,0x00,0x00},
  {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E},{0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
  {0x0E,0x11,0x01,0x06,0x08,0x10,0x1F},{0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
  {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02},{0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
  {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E},{0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
  {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E},{0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C},
  {0x00,0x0C,0x0C,0x00,0x0C,0x0C,0x00},{0x00,0x0C,0x0C,0x00,0x0C,0x04,0x08},
  {0x02,0x04,0x08,0x10,0x08,0x04,0x02},{0x00,0x00,0x1F,0x00,0x1F,0x00,0x00},
  {0x08,0x04,0x02,0x01,0x02,0x04,0x08},{0x0E,0x11,0x01,0x02,0x04,0x00,0x04},
  {0x0E,0x11,0x17,0x15,0x17,0x10,0x0E},{0x0E,0x11,0x11,0x1F,0x11,0x11,0x11},
  {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E},{0x0E,0x11,0x10,0x10,0x10,0x11,0x0E},
  {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E},{0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F},
  {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10},{0x0E,0x11,0x10,0x17,0x11,0x11,0x0F},
  {0x11,0x11,0x11,0x1F,0x11,0x11,0x11},{0x0E,0x04,0x04,0x04,0x04,0x04,0x0E},
  {0x01,0x01,0x01,0x01,0x11,0x11,0x0E},{0x11,0x12,0x14,0x18,0x14,0x12,0x11},
  {0x10,0x10,0x10,0x10,0x10,0x10,0x1F},{0x11,0x1B,0x15,0x15,0x11,0x11,0x11},
  {0x11,0x19,0x15,0x13,0x11,0x11,0x11},{0x0E,0x11,0x11,0x11,0x11,0x11,0x0E},
  {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10},{0x0E,0x11,0x11,0x11,0x15,0x12,0x0D},
  {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},{0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E},
  {0x1F,0x04,0x04,0x04,0x04,0x04,0x04},{0x11,0x11,0x11,0x11,0x11,0x11,0x0E},
  {0x11,0x11,0x11,0x11,0x11,0x0A,0x04},{0x11,0x11,0x11,0x15,0x15,0x1B,0x11},
  {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11},{0x11,0x11,0x0A,0x04,0x04,0x04,0x04},
  {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F},{0x0E,0x08,0x08,0x08,0x08,0x08,0x0E},
  {0x10,0x08,0x04,0x02,0x01,0x00,0x00},{0x0E,0x02,0x02,0x02,0x02,0x02,0x0E},
  {0x04,0x0A,0x11,0x00,0x00,0x00,0x00},{0x00,0x00,0x00,0x00,0x00,0x00,0x1F},
  {0x08,0x04,0x02,0x00,0x00,0x00,0x00},{0x00,0x00,0x0E,0x01,0x0F,0x11,0x0F},
  {0x10,0x10,0x1E,0x11,0x11,0x11,0x1E},{0x00,0x00,0x0E,0x10,0x10,0x11,0x0E},
  {0x01,0x01,0x0F,0x11,0x11,0x11,0x0F},{0x00,0x00,0x0E,0x11,0x1F,0x10,0x0E},
  {0x06,0x08,0x08,0x1E,0x08,0x08,0x08},{0x00,0x00,0x0F,0x11,0x0F,0x01,0x0E},
  {0x10,0x10,0x1E,0x11,0x11,0x11,0x11},{0x04,0x00,0x0C,0x04,0x04,0x04,0x0E},
  {0x02,0x00,0x06,0x02,0x02,0x12,0x0C},{0x10,0x10,0x12,0x14,0x18,0x14,0x12},
  {0x0C,0x04,0x04,0x04,0x04,0x04,0x0E},{0x00,0x00,0x1A,0x15,0x15,0x15,0x15},
  {0x00,0x00,0x1E,0x11,0x11,0x11,0x11},{0x00,0x00,0x0E,0x11,0x11,0x11,0x0E},
  {0x00,0x00,0x1E,0x11,0x1E,0x10,0x10},{0x00,0x00,0x0F,0x11,0x0F,0x01,0x01},
  {0x00,0x00,0x16,0x19,0x10,0x10,0x10},{0x00,0x00,0x0F,0x10,0x0E,0x01,0x1E},
  {0x08,0x08,0x1E,0x08,0x08,0x08,0x06},{0x00,0x00,0x11,0x11,0x11,0x11,0x0F},
  {0x00,0x00,0x11,0x11,0x11,0x0A,0x04},{0x00,0x00,0x11,0x15,0x15,0x15,0x0A},
  {0x00,0x00,0x11,0x0A,0x04,0x0A,0x11},{0x00,0x00,0x11,0x11,0x0F,0x01,0x0E},
  {0x00,0x00,0x1F,0x02,0x04,0x08,0x1F},{0x02,0x04,0x04,0x08,0x04,0x04,0x02},
  {0x04,0x04,0x04,0x04,0x04,0x04,0x04},{0x08,0x04,0x04,0x02,0x04,0x04,0x08},
  {0x00,0x00,0x08,0x15,0x02,0x00,0x00},
};

static void draw_char(int x, int y, char ch, uint8_t r, uint8_t g, uint8_t b) {
  if (ch < 32 || ch > 126) ch = '?';
  const uint8_t *gyl = GLYPH[ch - 32];
  for (int row = 0; row < 7; row++) {
    uint8_t bits = gyl[row];
    for (int col = 0; col < 5; col++)
      if (bits & (0x10 >> col)) put(x + col, y + row, r, g, b, 255);
  }
}

static void draw_text(int x, int y, const char *s, uint8_t r, uint8_t g, uint8_t b) {
  int cx = x;
  for (; *s; s++) {
    draw_char(cx, y, *s, r, g, b);
    cx += 6;
    if ((uint32_t)cx + 6 >= width) break;
  }
}

static void draw_text_clip(int x, int y, const char *s, int max_w, uint8_t r, uint8_t g, uint8_t b) {
  int cx = x;
  for (; *s; s++) {
    if (cx + 6 > x + max_w) break;
    draw_char(cx, y, *s, r, g, b);
    cx += 6;
  }
}

static void copy_capped(char *dst, int cap, const char *src, int len) {
  if (len < 0) len = 0;
  if (len >= cap) len = cap - 1;
  memcpy(dst, src, (size_t)len);
  dst[len] = 0;
}

static void layout_controls(void) {
  if (mode == MODE_RESULTS) {
    search_w = (int)width - 140;
    if (search_w < 180) search_w = 180;
    search_h = 28;
    search_x = 90;
    search_y = 78;
    btn_w = 64; btn_h = 28;
    btn_x = search_x + search_w - btn_w - 4;
    btn_y = search_y;
  } else {
    search_w = (int)width * 60 / 100;
    if (search_w < 240) search_w = 240;
    if (search_w > 440) search_w = 440;
    search_h = 36;
    search_x = ((int)width - search_w) / 2;
    search_y = (int)height / 2 - 4;
    btn_w = 88; btn_h = 30;
    btn_x = ((int)width - btn_w) / 2;
    btn_y = search_y + search_h + 16;
  }
}

static void draw_chrome(void) {
  fill(0, 0, (int)width, (int)height, 255, 255, 255, 255);
  fill(0, 0, (int)width, 36, 222, 88, 51, 255); /* DDG orange toolbar */
  fill(0, 36, (int)width, 26, 255, 255, 255, 255);
  fill(0, 62, (int)width, 1, 218, 220, 224, 255);
  fill(8, 8, 22, 20, 255, 255, 255, 60);
  fill(34, 8, 22, 20, 255, 255, 255, 60);
  fill(60, 8, 22, 20, 255, 255, 255, 60);
  fill(86, 8, 22, 20, 255, 255, 255, 60);
  draw_text(14, 13, "<", 255, 255, 255);
  draw_text(40, 13, ">", 255, 255, 255);
  draw_text(66, 13, "x", 255, 255, 255);
  draw_text(92, 13, "R", 255, 255, 255);
  fill(118, 8, (int)width - 160, 20, 255, 255, 255, 255);
  draw_text_clip(124, 13, address, (int)width - 180, 32, 33, 36);
  draw_text_clip(8, 43, title, (int)width - 24, 60, 64, 67);
}

static void draw_search_box(void) {
  fill(search_x - 1, search_y - 1, search_w + 2, search_h + 2, 200, 200, 200, 255);
  fill(search_x, search_y, search_w, search_h, 255, 255, 255, 255);
  if (search_focused) {
    fill(search_x, search_y, search_w, 2, 222, 88, 51, 255);
    fill(search_x, search_y + search_h - 2, search_w, 2, 222, 88, 51, 255);
    fill(search_x, search_y, 2, search_h, 222, 88, 51, 255);
    fill(search_x + search_w - 2, search_y, 2, search_h, 222, 88, 51, 255);
  }
  if (query_len == 0) {
    draw_text(search_x + 12, search_y + (search_h - 7) / 2, "Search DuckDuckGo…", 154, 160, 166);
  } else {
    draw_text_clip(search_x + 12, search_y + (search_h - 7) / 2, query, search_w - 28, 32, 33, 36);
    if (search_focused && caret_on) {
      int caret_x = search_x + 12 + query_len * 6;
      if (caret_x < search_x + search_w - 8)
        fill(caret_x, search_y + 8, 1, search_h - 16, 32, 33, 36, 255);
    }
  }
}

static void draw_home(void) {
  draw_text((int)width / 2 - 54, search_y - 56, "DuckDuckGo", 222, 88, 51);
  draw_text((int)width / 2 - 70, search_y - 36, "privacy, simplified", 95, 99, 104);
  draw_search_box();
  fill(btn_x, btn_y, btn_w, btn_h, 222, 88, 51, 255);
  draw_text(btn_x + 22, btn_y + 11, "Search", 255, 255, 255);
  draw_text(14, (int)height - 40, "Click the box, type a query, press Enter or Search", 120, 120, 120);
}

static void draw_results(void) {
  draw_text(14, 86, "DDG", 222, 88, 51);
  draw_search_box();
  fill(btn_x, btn_y, btn_w, btn_h, 222, 88, 51, 255);
  draw_text(btn_x + 14, btn_y + 10, "Search", 255, 255, 255);
  int y = search_y + search_h + 18;
  if (result_count == 0) draw_text(24, y, "Searching DuckDuckGo…", 95, 99, 104);
  for (int i = 0; i < result_count; i++) {
    if (y + 46 > (int)height - 28) break;
    draw_text_clip(24, y, results[i].url, (int)width - 48, 15, 157, 88);
    draw_text_clip(24, y + 12, results[i].title, (int)width - 48, 26, 13, 171);
    draw_text_clip(24, y + 26, results[i].snippet, (int)width - 48, 75, 79, 85);
    y += 52;
  }
}

static void draw_text_mode(void) {
  int y = 74;
  for (int i = 0; i < line_count; i++) {
    draw_text(14, y, lines[i], 30, 45, 60);
    y += 12;
    if (y > (int)height - 34) break;
  }
}

static void render_ui(void) {
  layout_controls();
  draw_chrome();
  if (mode == MODE_HOME) draw_home();
  else if (mode == MODE_RESULTS) draw_results();
  else draw_text_mode();
  fill(0, (int)height - 22, (int)width, 22, 248, 249, 250, 255);
  draw_text_clip(8, (int)height - 15, status_line, (int)width - 16, 95, 99, 104);
}

__attribute__((export_name("netsurf_init")))
int netsurf_init(int w, int h) {
  if (w < 320) w = 320;
  if (h < 200) h = 200;
  if (w > MAX_W) w = MAX_W;
  if (h > MAX_H) h = MAX_H;
  width = (uint32_t)w;
  height = (uint32_t)h;
  running = 1;
  mode = MODE_HOME;
  search_focused = 1;
  query_len = 0;
  query[0] = 0;
  result_count = 0;
  line_count = 0;
  strncpy(address, "https://html.duckduckgo.com/html/", sizeof address - 1);
  strncpy(title, "DuckDuckGo", sizeof title - 1);
  strncpy(status_line, "NetSurf · DuckDuckGo ready · click & type to search", sizeof status_line - 1);
  render_ui();
  return 1;
}

__attribute__((export_name("netsurf_frame_ptr")))
uint8_t *netsurf_frame_ptr(void) { return frame; }
__attribute__((export_name("netsurf_frame_len")))
int netsurf_frame_len(void) { return (int)(width * height * 4); }
__attribute__((export_name("netsurf_width")))
int netsurf_width(void) { return (int)width; }
__attribute__((export_name("netsurf_height")))
int netsurf_height(void) { return (int)height; }
__attribute__((export_name("netsurf_is_running")))
int netsurf_is_running(void) { return running; }

__attribute__((export_name("netsurf_render")))
int netsurf_render(int tick) {
  caret_on = ((tick / 400) & 1) == 0;
  if (!running) return 0;
  render_ui();
  return 1;
}

__attribute__((export_name("netsurf_address_buf")))
char *netsurf_address_buf(void) { return scratch; }
__attribute__((export_name("netsurf_address_cap")))
int netsurf_address_cap(void) { return ADDR_CAP; }
__attribute__((export_name("netsurf_commit_address")))
int netsurf_commit_address(int len) {
  copy_capped(address, ADDR_CAP, scratch, len);
  render_ui();
  return 1;
}
__attribute__((export_name("netsurf_commit_title")))
int netsurf_commit_title(int len) {
  copy_capped(title, TITLE_CAP, scratch, len);
  render_ui();
  return 1;
}
__attribute__((export_name("netsurf_clear_lines")))
void netsurf_clear_lines(void) { line_count = 0; }
__attribute__((export_name("netsurf_line_buf")))
char *netsurf_line_buf(void) { return scratch; }
__attribute__((export_name("netsurf_line_cap")))
int netsurf_line_cap(void) { return LINE_BUF; }
__attribute__((export_name("netsurf_add_line")))
int netsurf_add_line(int len) {
  if (line_count >= MAX_LINES) return 0;
  copy_capped(lines[line_count], LINE_BUF, scratch, len);
  line_count++;
  mode = MODE_TEXT;
  return 1;
}

__attribute__((export_name("netsurf_set_mode")))
int netsurf_set_mode(int next) {
  if (next < MODE_HOME || next > MODE_TEXT) return 0;
  mode = next;
  render_ui();
  return 1;
}
__attribute__((export_name("netsurf_mode")))
int netsurf_mode(void) { return mode; }

__attribute__((export_name("netsurf_query_buf")))
char *netsurf_query_buf(void) { return query; }
__attribute__((export_name("netsurf_query_cap")))
int netsurf_query_cap(void) { return QUERY_CAP; }
__attribute__((export_name("netsurf_set_query")))
int netsurf_set_query(int len) {
  /* Host writes UTF-8 bytes into netsurf_query_buf() then commits length. */
  if (len < 0) len = 0;
  if (len >= QUERY_CAP) len = QUERY_CAP - 1;
  query[len] = 0;
  query_len = len;
  search_focused = 1;
  render_ui();
  return query_len;
}
__attribute__((export_name("netsurf_query_len")))
int netsurf_query_len(void) { return query_len; }

__attribute__((export_name("netsurf_clear_results")))
void netsurf_clear_results(void) { result_count = 0; }

__attribute__((export_name("netsurf_add_result")))
int netsurf_add_result(int a, int b, int c) {
  (void)a; (void)b; (void)c;
  if (result_count >= MAX_RESULTS) return 0;
  Result *r = &results[result_count];
  char *t = scratch;
  char *u = NULL;
  char *s = NULL;
  for (int i = 0; scratch[i]; i++) {
    if (scratch[i] == '\n') {
      scratch[i] = 0;
      if (!u) u = scratch + i + 1;
      else { s = scratch + i + 1; break; }
    }
  }
  if (!u) u = "";
  if (!s) s = "";
  copy_capped(r->title, RESULT_TITLE, t, (int)strlen(t));
  copy_capped(r->url, RESULT_URL, u, (int)strlen(u));
  copy_capped(r->snippet, RESULT_SNIP, s, (int)strlen(s));
  result_count++;
  mode = MODE_RESULTS;
  return result_count;
}
__attribute__((export_name("netsurf_result_count")))
int netsurf_result_count(void) { return result_count; }

__attribute__((export_name("netsurf_search_x")))
int netsurf_search_x(void) { layout_controls(); return search_x; }
__attribute__((export_name("netsurf_search_y")))
int netsurf_search_y(void) { layout_controls(); return search_y; }
__attribute__((export_name("netsurf_search_w")))
int netsurf_search_w(void) { layout_controls(); return search_w; }
__attribute__((export_name("netsurf_search_h")))
int netsurf_search_h(void) { layout_controls(); return search_h; }

__attribute__((export_name("netsurf_pointer_down")))
int netsurf_pointer_down(int x, int y) {
  layout_controls();
  if (x >= search_x && x < search_x + search_w && y >= search_y && y < search_y + search_h) {
    search_focused = 1;
    render_ui();
    return 1;
  }
  if (x >= btn_x && x < btn_x + btn_w && y >= btn_y && y < btn_y + btn_h) return 2;
  if (mode == MODE_RESULTS) {
    int top = search_y + search_h + 18;
    for (int i = 0; i < result_count; i++) {
      if (y >= top && y < top + 50) return 10 + i;
      top += 52;
    }
  }
  search_focused = 0;
  render_ui();
  return 0;
}

__attribute__((export_name("netsurf_key")))
int netsurf_key(int key) {
  search_focused = 1;
  if (key == 8 || key == 127) {
    if (query_len > 0) { query_len--; query[query_len] = 0; render_ui(); }
    return 1;
  }
  if (key == 13 || key == 10) return 2;
  if (key >= 32 && key <= 126 && query_len < QUERY_CAP - 1) {
    query[query_len++] = (char)key;
    query[query_len] = 0;
    render_ui();
    return 1;
  }
  return 0;
}

__attribute__((export_name("netsurf_set_status")))
int netsurf_set_status(int len) {
  copy_capped(status_line, (int)sizeof status_line, scratch, len);
  render_ui();
  return 1;
}

__attribute__((export_name("netsurf_focus_search")))
int netsurf_focus_search(int on) {
  search_focused = on ? 1 : 0;
  render_ui();
  return search_focused;
}
