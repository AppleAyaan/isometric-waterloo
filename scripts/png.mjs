// Minimal dependency-free PNG reader/writer (8-bit greyscale, RGB, RGBA, palette; non-interlaced), plus
// the few image operations the site build needs. Everything works on RGBA buffers.
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width, height, depth, type, interlace, palette, trns;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), name = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4, s = i * ch;
    if (type === 2 || type === 6) { rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = type === 6 ? px[s + 3] : 255; }
    else if (type === 3) { const p = px[s]; rgba[o] = palette[p * 3]; rgba[o + 1] = palette[p * 3 + 1]; rgba[o + 2] = palette[p * 3 + 2]; rgba[o + 3] = trns && p < trns.length ? trns[p] : 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = type === 4 ? px[s + 1] : 255; }
  }
  return { width, height, data: rgba };
}

// RGBA in. Written as an indexed PNG when it has <= 256 colours, else RGB when fully opaque, else RGBA.
// Each row gets the filter that minimises the sum of abs deltas (indexed rows stay unfiltered).
export function encodePNG({ width, height, data }, level = 9) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const n = width * height, colors = new Map(), idx = new Uint8Array(n);
  for (let i = 0; i < n && colors.size <= 256; i++) {
    const key = data.readUInt32BE(i * 4);
    let k = colors.get(key);
    if (k === undefined) { k = colors.size; colors.set(key, k); }
    idx[i] = k;
  }
  const indexed = colors.size <= 256;
  const ch = indexed ? 1 : opaque ? 3 : 4, stride = width * ch;
  const px = indexed ? Buffer.from(idx.buffer) : Buffer.alloc(stride * height);
  if (!indexed) for (let i = 0; i < n; i++) for (let k = 0; k < ch; k++) px[i * ch + k] = data[i * 4 + k];
  const raw = Buffer.alloc((stride + 1) * height), cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < (indexed ? 1 : 5); f++) {
      const out = cand[f]; let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = px[row + x], a = x >= ch ? px[row + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0;
        let p = v;
        if (f === 1) p = v - a; else if (f === 2) p = v - b; else if (f === 3) p = v - ((a + b) >> 1);
        else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        out[x] = p & 255; sum += out[x] < 128 ? out[x] : 256 - out[x];
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (name, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const nb = Buffer.concat([Buffer.from(name, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(nb));
    return Buffer.concat([len, nb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = indexed ? 3 : opaque ? 2 : 6;
  const extra = [];
  if (indexed) {
    const keys = [...colors.keys()], plte = Buffer.alloc(keys.length * 3), trns = Buffer.alloc(keys.length);
    keys.forEach((k, i) => { plte[i * 3] = k >>> 24; plte[i * 3 + 1] = (k >>> 16) & 255; plte[i * 3 + 2] = (k >>> 8) & 255; trns[i] = k & 255; });
    extra.push(chunk('PLTE', plte));
    if (!opaque) extra.push(chunk('tRNS', trns));
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

export function crop(img, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  return { width: w, height: h, data: out };
}

// Area-average resize (good for shrinking; pixels are averaged in premultiplied alpha).
export function resize(img, w, h) {
  const out = Buffer.alloc(w * h * 4), sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
          const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx)), i = (yy * img.width + xx) * 4, al = img.data[i + 3] / 255;
          r += img.data[i] * al * wgt; g += img.data[i + 1] * al * wgt; b += img.data[i + 2] * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / wsum) * 255);
    }
  }
  return { width: w, height: h, data: out };
}
