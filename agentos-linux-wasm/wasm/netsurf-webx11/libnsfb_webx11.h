/*
 * Public hooks for the AgentOS webx11 libnsfb surface.
 * Implemented by the thin X11 PutImage host adapter; declared here so the
 * surface compiles cleanly under -Wmissing-prototypes without changing
 * NetSurf browser core.
 */
#ifndef LIBNSFB_WEBX11_H
#define LIBNSFB_WEBX11_H

#include "libnsfb.h"
#include "libnsfb_event.h"

#ifdef __cplusplus
extern "C" {
#endif

void webx11_host_present(nsfb_t *nsfb, const nsfb_bbox_t *box);
void webx11_host_poll(void);

int webx11_push_event(const nsfb_event_t *event);
int webx11_queue_count(void);
int webx11_is_dirty(void);
void webx11_clear_dirty(void);

extern nsfb_t *webx11_current_nsfb;

#ifdef __cplusplus
}
#endif

#endif /* LIBNSFB_WEBX11_H */
