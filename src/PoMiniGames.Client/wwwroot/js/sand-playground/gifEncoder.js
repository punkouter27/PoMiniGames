// gifEncoder.js — Minimal, zero-dependency animated GIF89a encoder for SandPlayground.
// Quantizes RGBA frames into a fixed 256-color palette (6x6x6 color cube + 40-step grayscale)
// and packs LZW image blocks directly into a Blob (`image/gif`).

function buildPalette() {
    const pal = new Uint8Array(256 * 3);
    let idx = 0;
    for (let r = 0; r < 6; r++) {
        for (let g = 0; g < 6; g++) {
            for (let b = 0; b < 6; b++) {
                pal[idx++] = Math.round((r * 255) / 5);
                pal[idx++] = Math.round((g * 255) / 5);
                pal[idx++] = Math.round((b * 255) / 5);
            }
        }
    }
    for (let k = 0; k < 40; k++) {
        const v = Math.round((k * 255) / 39);
        pal[idx++] = v;
        pal[idx++] = v;
        pal[idx++] = v;
    }
    return pal;
}

const PALETTE = buildPalette();

function quantizeRgba(rgba, width, height) {
    const n = width * height;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const r = rgba[p];
        const g = rgba[p + 1];
        const b = rgba[p + 2];
        // Use grayscale ramp when chroma is low for smooth sky/smoke gradients.
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 10) {
            const lum = (r * 77 + g * 150 + b * 29) >> 8;
            out[i] = 216 + Math.min(39, Math.round((lum * 39) / 255));
        } else {
            const ri = Math.round((r * 5) / 255);
            const gi = Math.round((g * 5) / 255);
            const bi = Math.round((b * 5) / 255);
            out[i] = ri * 36 + gi * 6 + bi;
        }
    }
    return out;
}

function lzwEncode(indices, minCodeSize = 8) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const bytes = [];
    let curByte = 0;
    let curBits = 0;

    const writeBits = (code, bits) => {
        curByte |= code << curBits;
        curBits += bits;
        while (curBits >= 8) {
            bytes.push(curByte & 0xff);
            curByte >>= 8;
            curBits -= 8;
        }
    };

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();

    const reset = () => {
        dict.clear();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
        writeBits(clearCode, codeSize);
    };

    reset();
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const found = dict.get(key);
        if (found !== undefined) {
            prefix = found;
        } else {
            writeBits(prefix, codeSize);
            if (nextCode < 4096) {
                dict.set(key, nextCode++);
                if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
            } else {
                writeBits(clearCode, codeSize);
                dict.clear();
                codeSize = minCodeSize + 1;
                nextCode = eoiCode + 1;
            }
            prefix = k;
        }
    }
    writeBits(prefix, codeSize);
    writeBits(eoiCode, codeSize);
    if (curBits > 0) bytes.push(curByte & 0xff);
    return bytes;
}

/**
 * Encode an array of `{ rgba: Uint8ClampedArray, delayCs?: number }` frames into an animated GIF Blob.
 * @param {{ width: number, height: number, frames: Array<{ rgba: Uint8ClampedArray|Uint8Array, delayCs?: number }> }} opts
 */
export function encodeGif({ width, height, frames }) {
    const out = [];
    const pushStr = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
    const pushU16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };

    // Header + Logical Screen Descriptor (Global Color Table, 256 colors)
    pushStr('GIF89a');
    pushU16(width);
    pushU16(height);
    out.push(0xf7, 0x00, 0x00); // GCT flag=1, color res=7, sort=0, size=7 (256)
    for (let i = 0; i < PALETTE.length; i++) out.push(PALETTE[i]);

    // Netscape 2.0 Application Extension (infinite loop)
    out.push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);

    for (const frame of frames) {
        const delay = Math.max(2, Math.round(frame.delayCs ?? 8));
        // Graphic Control Extension
        out.push(0x21, 0xf9, 0x04, 0x00);
        pushU16(delay);
        out.push(0x00, 0x00);

        // Image Descriptor
        out.push(0x2c);
        pushU16(0);
        pushU16(0);
        pushU16(width);
        pushU16(height);
        out.push(0x00);

        // LZW Minimum Code Size + sub-blocks
        out.push(0x08);
        const indices = quantizeRgba(frame.rgba, width, height);
        const lzw = lzwEncode(indices, 8);
        for (let i = 0; i < lzw.length; i += 255) {
            const len = Math.min(255, lzw.length - i);
            out.push(len);
            for (let j = 0; j < len; j++) out.push(lzw[i + j]);
        }
        out.push(0x00);
    }

    out.push(0x3b); // Trailer
    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
}
