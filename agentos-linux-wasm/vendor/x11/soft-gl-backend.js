'use strict';

// Self-contained soft GL backend for in-tab GLX (no WebGL / browser/glx import).
// Enough for QueryVersion / CreateContext / MakeCurrent / SwapBuffers clear+rect.

class SoftGLBackend {
    constructor() {
        this.calls = [];
        this.caps = new Set();
        this.width = 0;
        this.height = 0;
        this.clearColorValue = [0, 0, 0, 1];
        this._color = [1, 1, 1, 1];
        this.pixels = new Uint32Array(0);
    }

    matrixMode() {}
    loadIdentity() {}
    loadMatrix() {}
    multMatrix() {}
    pushMatrix() {}
    popMatrix() {}
    rotate() {}
    translate() {}
    scale() {}
    ortho() {}
    frustum() {}
    begin() {}
    end() {}
    vertex() {}
    normal() {}
    texCoord() {}
    rasterPos() {}
    viewport() {}
    clearDepth() {}
    clearStencil() {}
    colorMask() {}
    depthMask() {}
    stencilMask() {}
    drawBuffer() {}
    readBuffer() {}
    depthFunc() {}
    alphaFunc() {}
    blendFunc() {}
    logicOp() {}
    stencilFunc() {}
    stencilOp() {}
    cullFace() {}
    frontFace() {}
    shadeModel() {}
    polygonMode() {}
    scissor() {}
    lineWidth() {}
    lineStipple() {}
    pointSize() {}
    hint() {}
    light() {}
    lightModel() {}
    material() {}
    colorMaterial() {}
    fog() {}
    bindTexture() {}
    deleteTextures() {}
    texParameter() {}
    texEnv() {}
    texGen() {}
    texImage2D() {}
    programString() {}
    bindProgram() {}
    finish() {}
    flush() {}

    enable(cap) { this.caps.add(cap); }
    disable(cap) { this.caps.delete(cap); }
    isEnabled(cap) { return this.caps.has(cap); }

    color(r, g, b, a) {
        this._color = [r, g, b, typeof a === 'number' ? a : 1];
    }

    clearColor(r, g, b, a) {
        this.clearColorValue = [r, g, b, a];
    }

    clear() {
        this._fillClear();
    }

    rectf(x1, y1, x2, y2) {
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

    resize(width, height) {
        this.width = width | 0;
        this.height = height | 0;
        const n = Math.max(0, this.width * this.height);
        if (this.pixels.length !== n)
            this.pixels = new Uint32Array(n);
        this._fillClear();
    }

    readPixels() {
        return Buffer.alloc(0);
    }

    readPixelsUint32(w, h) {
        if (w === this.width && h === this.height)
            return this.pixels;
        const out = new Uint32Array(w * h);
        const cw = Math.min(w, this.width);
        const ch = Math.min(h, this.height);
        for (let y = 0; y < ch; y++)
            out.set(this.pixels.subarray(y * this.width, y * this.width + cw), y * w);
        return out;
    }

    getParameter() {
        return null;
    }

    getString(name) {
        switch (name) {
            case 0x1F00: return 'agentos-linux-wasm';
            case 0x1F01: return 'SoftGL';
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
        if (this.pixels.length)
            this.pixels.fill(this._pack(this.clearColorValue));
    }
}

function createGlBackend() {
    return new SoftGLBackend();
}

module.exports = { SoftGLBackend, createGlBackend };
