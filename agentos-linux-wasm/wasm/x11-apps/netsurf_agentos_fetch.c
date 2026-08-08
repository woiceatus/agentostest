/*
 * Thin AgentOS network adapter for ORIGINAL NetSurf.
 *
 * Replaces curl's HTTP(S) registration (via --wrap=fetch_curl_register) with
 * fetches through the in-tab AgentOS proxy (/__agentos/proxy). Browser handles
 * TLS. Does not modify NetSurf browser core sources.
 */
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "utils/nsurl.h"
#include "utils/corestrings.h"
#include "utils/errors.h"
#include "utils/ring.h"

#include "content/fetch.h"
#include "content/fetchers.h"

/* From NetSurf curl fetcher API */
nserror __real_fetch_curl_register(void);

extern int agentos_js_http_fetch(const char *url, const char *method,
				 const char *body, int body_len,
				 int *out_status, char **out_final_url,
				 uint8_t **out_body, int *out_body_len);

struct agentos_fetch_ctx {
	struct agentos_fetch_ctx *r_next, *r_prev;
	struct fetch *fetchh;
	nsurl *url;
	char *post_urlenc;
	bool aborted;
	bool locked;
	bool started;
};

static struct agentos_fetch_ctx *ring;

static bool agentos_initialise(lwc_string *scheme)
{
	(void)scheme;
	return true;
}

static void agentos_finalise(lwc_string *scheme)
{
	(void)scheme;
}

static bool agentos_can_fetch(const nsurl *url)
{
	(void)url;
	return true;
}

static void *agentos_setup(struct fetch *fetchh, nsurl *url, bool only_2xx,
			   bool downgrade_tls, const char *post_urlenc,
			   const struct fetch_multipart_data *post_multipart,
			   const char **headers)
{
	struct agentos_fetch_ctx *ctx;

	(void)only_2xx;
	(void)downgrade_tls;
	(void)post_multipart;
	(void)headers;

	ctx = calloc(1, sizeof(*ctx));
	if (!ctx)
		return NULL;
	ctx->fetchh = fetchh;
	ctx->url = nsurl_ref(url);
	if (post_urlenc)
		ctx->post_urlenc = strdup(post_urlenc);
	RING_INSERT(ring, ctx);
	return ctx;
}

static bool agentos_start(void *handle)
{
	struct agentos_fetch_ctx *ctx = handle;
	ctx->started = true;
	return true;
}

static void agentos_abort(void *handle)
{
	struct agentos_fetch_ctx *ctx = handle;
	ctx->aborted = true;
}

static void agentos_free(void *handle)
{
	struct agentos_fetch_ctx *ctx = handle;
	RING_REMOVE(ring, ctx);
	nsurl_unref(ctx->url);
	free(ctx->post_urlenc);
	free(ctx);
}

static void agentos_send_header(struct agentos_fetch_ctx *ctx, const char *fmt, ...)
{
	char buf[4096];
	va_list ap;
	fetch_msg msg;

	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);

	msg.type = FETCH_HEADER;
	msg.data.header_or_data.buf = (const uint8_t *)buf;
	msg.data.header_or_data.len = strlen(buf);
	fetch_send_callback(&msg, ctx->fetchh);
}

static void agentos_process(struct agentos_fetch_ctx *ctx)
{
	fetch_msg msg;
	const char *url;
	const char *method = "GET";
	const char *body = NULL;
	int body_len = 0;
	int status = 0;
	char *final_url = NULL;
	uint8_t *resp = NULL;
	int resp_len = 0;
	int rc;

	url = nsurl_access(ctx->url);
	if (ctx->post_urlenc) {
		method = "POST";
		body = ctx->post_urlenc;
		body_len = (int)strlen(body);
	}

	ctx->locked = true;
	rc = agentos_js_http_fetch(url, method, body, body_len, &status,
				   &final_url, &resp, &resp_len);
	ctx->locked = false;

	if (ctx->aborted)
		goto done;

	if (rc != 0 || status <= 0) {
		msg.type = FETCH_ERROR;
		msg.data.error = final_url ? final_url : "AgentOS proxy fetch failed";
		fetch_send_callback(&msg, ctx->fetchh);
		goto done;
	}

	/* Proxy already followed redirects and returned the final body. */
	{
		const char *ctype = "text/html; charset=utf-8";
		if (final_url) {
			char *sep = strchr(final_url, '\0');
			/* meta is "url\0content-type" allocated as one buffer */
			if (sep && sep[1] != '\0')
				ctype = sep + 1;
		}

		fetch_set_http_code(ctx->fetchh, (http_response_code)status);

		if (!ctx->aborted)
			agentos_send_header(ctx, "HTTP/1.0 %d OK", status);
		if (!ctx->aborted)
			agentos_send_header(ctx, "Content-Type: %s", ctype);
		if (!ctx->aborted)
			agentos_send_header(ctx, "Content-Length: %d", resp_len);
	}

	if (!ctx->aborted && resp && resp_len > 0) {
		msg.type = FETCH_DATA;
		msg.data.header_or_data.buf = resp;
		msg.data.header_or_data.len = (size_t)resp_len;
		fetch_send_callback(&msg, ctx->fetchh);
	}

	if (!ctx->aborted) {
		msg.type = FETCH_FINISHED;
		fetch_send_callback(&msg, ctx->fetchh);
	}

done:
	free(final_url);
	free(resp);
}

static void agentos_poll(lwc_string *scheme)
{
	struct agentos_fetch_ctx *ctx, *save_ring = NULL;

	(void)scheme;
	while (ring != NULL) {
		ctx = ring;
		RING_REMOVE(ring, ctx);

		if (ctx->locked) {
			RING_INSERT(save_ring, ctx);
			continue;
		}
		if (!ctx->aborted && ctx->started)
			agentos_process(ctx);

		fetch_remove_from_queues(ctx->fetchh);
		fetch_free(ctx->fetchh);
	}
	ring = save_ring;
}

/* Linker --wrap replaces NetSurf's curl HTTP(S) registration. */
nserror __wrap_fetch_curl_register(void)
{
	const struct fetcher_operation_table ops = {
		.initialise = agentos_initialise,
		.acceptable = agentos_can_fetch,
		.setup = agentos_setup,
		.start = agentos_start,
		.abort = agentos_abort,
		.free = agentos_free,
		.poll = agentos_poll,
		.finalise = agentos_finalise,
	};
	nserror err;

	/* Do not call __real_fetch_curl_register — wasm curl has no TLS/sockets.
	 * AgentOS proxy (browser TLS) is the HTTP(S) path instead.
	 */
	(void)__real_fetch_curl_register;

	err = fetcher_add(lwc_string_ref(corestring_lwc_http), &ops);
	if (err != NSERROR_OK)
		return err;
	err = fetcher_add(lwc_string_ref(corestring_lwc_https), &ops);
	return err;
}
