/*
 * Copyright 2026 AgentOS — web XServer surface adapter for libnsfb
 *
 * Additive surface handler only. Does not alter NetSurf browser core.
 * Provides a RAM framebuffer + input queue so original NetSurf framebuffer
 * frontend can run under the in-tab JS XServer (PutImage via host hook).
 *
 * Based on the upstream ram surface (MIT Licence).
 */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libnsfb.h"
#include "libnsfb_plot.h"
#include "libnsfb_event.h"
#include "libnsfb_webx11.h"

#include "nsfb.h"
#include "surface.h"
#include "plot.h"

#define UNUSED(x) ((x) = (x))
#define WEBX11_QUEUE 128

struct webx11_state {
	nsfb_event_t queue[WEBX11_QUEUE];
	int head;
	int tail;
	int count;
	int dirty;
	nsfb_bbox_t dirty_box;
	int dirty_box_valid;
};

static struct webx11_state g_webx11;

/* Host (X11 bridge) may set these; kept weak so native builds still link. */
void webx11_host_present(nsfb_t *nsfb, const nsfb_bbox_t *box) __attribute__((weak));
void webx11_host_present(nsfb_t *nsfb, const nsfb_bbox_t *box)
{
	UNUSED(nsfb);
	UNUSED(box);
}

void webx11_host_poll(void) __attribute__((weak));
void webx11_host_poll(void)
{
}

int webx11_push_event(const nsfb_event_t *event)
{
	if (g_webx11.count >= WEBX11_QUEUE)
		return -1;
	g_webx11.queue[g_webx11.tail] = *event;
	g_webx11.tail = (g_webx11.tail + 1) % WEBX11_QUEUE;
	g_webx11.count++;
	return 0;
}

int webx11_queue_count(void)
{
	return g_webx11.count;
}

nsfb_t *webx11_current_nsfb;
int webx11_is_dirty(void)
{
	return g_webx11.dirty;
}
void webx11_clear_dirty(void)
{
	g_webx11.dirty = 0;
	g_webx11.dirty_box_valid = 0;
}

static int webx11_defaults(nsfb_t *nsfb)
{
	nsfb->width = 800;
	nsfb->height = 600;
	nsfb->format = NSFB_FMT_XRGB8888;
	select_plotters(nsfb);
	return 0;
}

static int webx11_initialise(nsfb_t *nsfb)
{
	size_t size;
	uint8_t *fbptr;

	size = (size_t)(nsfb->width * nsfb->height * nsfb->bpp) / 8;
	fbptr = realloc(nsfb->ptr, size);
	if (fbptr == NULL)
		return -1;
	memset(fbptr, 0xff, size);
	nsfb->ptr = fbptr;
	nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
	webx11_current_nsfb = nsfb;
	g_webx11.dirty = 1;
	g_webx11.dirty_box_valid = 0;
	return 0;
}

static int webx11_set_geometry(nsfb_t *nsfb, int width, int height,
			       enum nsfb_format_e format)
{
	int startsize;
	int endsize;
	int prev_width = nsfb->width;
	int prev_height = nsfb->height;
	enum nsfb_format_e prev_format = nsfb->format;

	startsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
	if (width > 0)
		nsfb->width = width;
	if (height > 0)
		nsfb->height = height;
	if (format != NSFB_FMT_ANY)
		nsfb->format = format;
	select_plotters(nsfb);
	endsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
	if ((nsfb->ptr != NULL) && (startsize != endsize)) {
		uint8_t *fbptr = realloc(nsfb->ptr, (size_t)endsize);
		if (fbptr == NULL) {
			nsfb->width = prev_width;
			nsfb->height = prev_height;
			nsfb->format = prev_format;
			select_plotters(nsfb);
			return -1;
		}
		nsfb->ptr = fbptr;
	}
	nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
	webx11_current_nsfb = nsfb;
	g_webx11.dirty = 1;
	g_webx11.dirty_box_valid = 0;
	return 0;
}

static int webx11_finalise(nsfb_t *nsfb)
{
	free(nsfb->ptr);
	nsfb->ptr = NULL;
	if (webx11_current_nsfb == nsfb)
		webx11_current_nsfb = NULL;
	return 0;
}

static void webx11_flush_present(nsfb_t *nsfb)
{
	if (!g_webx11.dirty || !webx11_host_present)
		return;
	webx11_host_present(nsfb,
			    g_webx11.dirty_box_valid ? &g_webx11.dirty_box
						     : NULL);
}

static bool webx11_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
	if (webx11_host_poll)
		webx11_host_poll();
	/* Batch PutImage once per input tick (not on every plotter update). */
	webx11_flush_present(nsfb);
#ifdef __EMSCRIPTEN__
	/*
	 * Cap sleep hard so keystrokes stay responsive under ASYNCIFY.
	 * Prefer draining the queue with no sleep when events are pending.
	 */
	if (g_webx11.count == 0 && timeout != 0) {
		extern void emscripten_sleep(unsigned int ms);
		unsigned ms = timeout > 0 ? (unsigned)timeout : 4u;
		if (ms > 4u)
			ms = 4u;
		emscripten_sleep(ms);
		if (webx11_host_poll)
			webx11_host_poll();
		webx11_flush_present(nsfb);
	}
#else
	UNUSED(timeout);
#endif
	if (g_webx11.count > 0) {
		*event = g_webx11.queue[g_webx11.head];
		g_webx11.head = (g_webx11.head + 1) % WEBX11_QUEUE;
		g_webx11.count--;
		return true;
	}
	event->type = NSFB_EVENT_CONTROL;
	event->value.controlcode = NSFB_CONTROL_TIMEOUT;
	return true;
}

static int webx11_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
	UNUSED(nsfb);
	g_webx11.dirty = 1;
	if (box != NULL) {
		if (!g_webx11.dirty_box_valid) {
			g_webx11.dirty_box = *box;
			g_webx11.dirty_box_valid = 1;
		} else {
			if (box->x0 < g_webx11.dirty_box.x0)
				g_webx11.dirty_box.x0 = box->x0;
			if (box->y0 < g_webx11.dirty_box.y0)
				g_webx11.dirty_box.y0 = box->y0;
			if (box->x1 > g_webx11.dirty_box.x1)
				g_webx11.dirty_box.x1 = box->x1;
			if (box->y1 > g_webx11.dirty_box.y1)
				g_webx11.dirty_box.y1 = box->y1;
		}
	} else {
		g_webx11.dirty_box_valid = 0;
	}
	/* Defer present to webx11_input — avoids one PutImage per plotter call. */
	return 0;
}

const nsfb_surface_rtns_t webx11_rtns = {
	.defaults = webx11_defaults,
	.initialise = webx11_initialise,
	.finalise = webx11_finalise,
	.input = webx11_input,
	.geometry = webx11_set_geometry,
	.update = webx11_update,
};

NSFB_SURFACE_DEF(webx11, NSFB_SURFACE_WEBX11, &webx11_rtns)
