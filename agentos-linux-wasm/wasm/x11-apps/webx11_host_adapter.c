/*
 * Thin AgentOS adapter: original NetSurf libnsfb "webx11" surface → JS XServer.
 *
 * Does NOT modify NetSurf browser core. Overrides the weak webx11_host_* hooks
 * from libnsfb and presents the framebuffer with real X11 PutImage.
 */
#include "mini_x11.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <libnsfb.h>
#include <libnsfb_event.h>
#include <libnsfb_webx11.h>

#ifndef NS_W
#define NS_W 800
#endif
#ifndef NS_H
#define NS_H 600
#endif

static XConn conn;
static uint32_t win;
static uint32_t gc;
static int ready;
static uint32_t xpixels[NS_W * NS_H];

static int ensure_window(int width, int height)
{
	if (ready)
		return 0;
	if (x_connect(&conn) != 0)
		return -1;
	if (width <= 0)
		width = NS_W;
	if (height <= 0)
		height = NS_H;
	if (width > NS_W)
		width = NS_W;
	if (height > NS_H)
		height = NS_H;

	win = x_new_id(&conn);
	gc = x_new_id(&conn);
	/* KeyPress|KeyRelease|ButtonPress|ButtonRelease|PointerMotion|Exposure|StructureNotify */
	uint32_t mask = 0x0001u | 0x0002u | 0x0004u | 0x0008u | 0x0040u | 0x8000u | 0x20000u;
	x_create_window(&conn, win, 40, 40, width, height, 0xffffffu, mask);
	x_create_gc(&conn, gc, win, 0x000000u, 0xffffffu);
	x_map_window(&conn, win);
	x_image_text8(&conn, win, gc, 8, 16, "NetSurf");
	ready = 1;
	x11_js_log("webx11_host: original NetSurf mapped on JS XServer");
	return 0;
}

static void push_key(int unicode, int down)
{
	nsfb_event_t ev;
	memset(&ev, 0, sizeof(ev));
	ev.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
	ev.value.keycode = (enum nsfb_key_code_e)unicode;
	webx11_push_event(&ev);
}

static void push_move(int x, int y)
{
	nsfb_event_t ev;
	memset(&ev, 0, sizeof(ev));
	ev.type = NSFB_EVENT_MOVE_ABSOLUTE;
	ev.value.vector.x = x;
	ev.value.vector.y = y;
	webx11_push_event(&ev);
}

static void push_button(int button, int down)
{
	nsfb_event_t ev;
	int code = NSFB_KEY_MOUSE_1;
	if (button == 2)
		code = NSFB_KEY_MOUSE_2;
	else if (button == 3)
		code = NSFB_KEY_MOUSE_3;
	memset(&ev, 0, sizeof(ev));
	ev.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
	ev.value.keycode = (enum nsfb_key_code_e)code;
	webx11_push_event(&ev);
}

static int keycode_to_latin1(int keycode)
{
	if (keycode >= 24 && keycode <= 33) {
		static const char row[] = "qwertyuiop";
		return row[keycode - 24];
	}
	if (keycode >= 38 && keycode <= 46) {
		static const char row[] = "asdfghjkl";
		return row[keycode - 38];
	}
	if (keycode >= 52 && keycode <= 58) {
		static const char row[] = "zxcvbnm";
		return row[keycode - 52];
	}
	if (keycode == 65)
		return ' ';
	if (keycode == 36)
		return '\r';
	if (keycode == 22)
		return '\b';
	if (keycode >= 10 && keycode <= 19) {
		static const char row[] = "1234567890";
		return row[keycode - 10];
	}
	return 0;
}

void webx11_host_poll(void)
{
	XEvent ev;
	if (!ready)
		return;
	while (x_next_event(&conn, &ev)) {
		switch (ev.type) {
		case X_MotionNotify:
			push_move(ev.x, ev.y);
			break;
		case X_ButtonPress:
			push_move(ev.x, ev.y);
			push_button(ev.detail, 1);
			break;
		case X_ButtonRelease:
			push_move(ev.x, ev.y);
			push_button(ev.detail, 0);
			break;
		case X_KeyPress: {
			int ch = keycode_to_latin1(ev.detail);
			if (ch)
				push_key(ch, 1);
			break;
		}
		case X_KeyRelease: {
			int ch = keycode_to_latin1(ev.detail);
			if (ch)
				push_key(ch, 0);
			break;
		}
		default:
			break;
		}
	}
}

void webx11_host_present(nsfb_t *nsfb)
{
	uint8_t *ptr = NULL;
	int linelen = 0;
	int width = 0, height = 0;
	enum nsfb_format_e fmt = NSFB_FMT_ANY;
	int w, h, x, y;

	if (!nsfb)
		return;
	nsfb_get_geometry(nsfb, &width, &height, &fmt);
	if (ensure_window(width, height) != 0)
		return;
	if (nsfb_get_buffer(nsfb, &ptr, &linelen) != 0 || !ptr)
		return;

	w = width;
	h = height;
	if (w > NS_W)
		w = NS_W;
	if (h > NS_H)
		h = NS_H;

	/* NetSurf webx11 uses XRGB8888 (0x00RRGGBB in little-endian memory). */
	for (y = 0; y < h; y++) {
		const uint32_t *src = (const uint32_t *)(ptr + y * linelen);
		uint32_t *dst = xpixels + (size_t)y * (size_t)w;
		for (x = 0; x < w; x++)
			dst[x] = src[x] & 0x00ffffffu;
	}

	x_put_image_zpixmap32(&conn, win, gc, 0, 0, w, h, xpixels);
	webx11_host_poll();
	webx11_clear_dirty();
}
