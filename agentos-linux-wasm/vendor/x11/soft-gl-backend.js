'use strict';

// Software / OffscreenCanvas-WebGL backend for in-tab GLX.
// Prefer WebGL2 when OffscreenCanvas is available; otherwise paint a soft
// clear-color framebuffer that SwapBuffers can present into X drawables.

const { RecordingBackend, WebGLBackend, BACKEND_METHODS } = require('x11/browser/glx/gl-backend.js');

class SoftGLBackend extends RecordingBackend {
    constructor() {
        super();
        this.clearColor = [0, 0, 0, 1];
        this.pixels = new Uint32Array(0);
        this._color = [1, 1, 1, 1];
    }

    resize(width, height) {
        super.resize(width, height);
        const n = Math.max(0, (width | 0) * (height | 0));
        if (this.pixels.length !== n)
            this.pixels = new Uint32Array(n);
        this._fillClear();
    }

    clearColor(r, g, b, a) {
        this.calls.push(['clearColor', r, g, b, a]);
        this.clearColor = [r, g, b, a];
    }

    color(r, g, b, a) {
        this.calls.push(['color', r, g, b, a]);
        this._color = [r, g, b, typeof a === 'number' ? a : 1];
    }

    clear(mask) {
        this.calls.push(['clear', mask]);
        this._fillClear();
    }

    rectf(x1, y1, x2, y2) {
        this.calls.push(['rectf', x1, y1, x2, y2]);
        const c = this._pack(this._color);
        const x0 = Math.max(0, Math.min(this.width, Math.floor(Math.min(x1, x2))));
        const x1i = Math.max(0, Math.min(this.width, Math.ceil(Math.max(x1, x2))));
        const y0 = Math.max(0, Math.min(this.height, Math.floor(Math.min(y1, y2))));
        const y1i = Math.max(0, Math.min(this.height, Math.ceil(Math.max(y1, y2))));
        for (let y = y0; y < y1i; y++) {
            const row = y * this.width;
            for (let x = x0; x < x1i; x++)
                this.pixels[row + x] = c;
        }
    }

    readPixelsUint32(w, h) {
        this.calls.push(['readPixelsUint32', w, h]);
        if (w === this.width && h === this.height)
            return this.pixels;
        const out = new Uint32Array(w * h);
        const cw = Math.min(w, this.width);
        const ch = Math.min(h, this.height);
        for (let y = 0; y < ch; y++)
            out.set(this.pixels.subarray(y * this.width, y * this.width + cw), y * w);
        return out;
    }

    getString(name) {
        this.calls.push(['getString', name]);
        switch (name) {
            case 0x1F00: return 'agentos-linux-wasm';
            case 0x1F01: return 'SoftGL (CPU / OffscreenCanvas)';
            case 0x1F02: return '1.4 agentos soft-glx';
            case 0x1F03: return '';
            default: return null;
        }
    }

    _pack(rgba) {
        const r = Math.max(0, Math.min(255, Math.round(rgba[0] * 255)));
        const g = Math.max(0, Math.min(255, Math.round(rgba[1] * 255)));
        const b = Math.max(0, Math.min(255, Math.round(rgba[2] * 255)));
        return (r << 16) | (g << 8) | b;
    }

    _fillClear() {
        if (!this.pixels.length)
            return;
        this.pixels.fill(this._pack(this.clearColor));
    }
}

function tryCreateWebGLBackend() {
    try {
        if (typeof OffscreenCanvas === 'undefined')
            return null;
        const canvas = new OffscreenCanvas(64, 64);
        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            stencil: true,
            depth: true,
            alpha: false
        });
        if (!gl)
            return null;
        const backend = new WebGLBackend(gl);
        backend._offscreenCanvas = canvas;
        const origResize = backend.resize.bind(backend);
        backend.resize = (w, h) => {
            canvas.width = Math.max(1, w | 0);
            canvas.height = Math.max(1, h | 0);
            return origResize(w, h);
        };
        return backend;
    } catch {
        return null;
    }
}

function createGlBackend() {
    return tryCreateWebGLBackend() || new SoftGLBackend();
}

module.exports = {
    SoftGLBackend,
    createGlBackend,
    BACKEND_METHODS,
    RecordingBackend,
    WebGLBackend
};
