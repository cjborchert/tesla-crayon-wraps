/* Crayon Wraps engine: photo of a coloured-in wrap template -> wrap PNG.
   Pure JavaScript, no dependencies. All processing happens locally in the browser. */
const WrapEngine = (() => {
  "use strict";
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const paint = () => new Promise((r) => {
    let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    setTimeout(go, 100);
  });

  // ---------------------------------------------------------------- filters
  // Running max/min over a (2r+1) window along rows or columns (window truncated at edges).
  function morph1D(a, w, h, r, isMax, hor) {
    const out = new Float32Array(w * h);
    const n = hor ? w : h, lines = hor ? h : w, step = hor ? 1 : w;
    const dq = new Int32Array(n + 1);
    for (let L = 0; L < lines; L++) {
      const base = hor ? L * w : L;
      let head = 0, tail = 0;
      for (let j = 0; j < n + r; j++) {
        if (j < n) {
          const v = a[base + j * step];
          if (isMax) { while (tail > head && a[base + dq[tail - 1] * step] <= v) tail--; }
          else { while (tail > head && a[base + dq[tail - 1] * step] >= v) tail--; }
          dq[tail++] = j;
        }
        const i = j - r;
        if (i >= 0) {
          while (dq[head] < i - r) head++;
          out[base + i * step] = a[base + dq[head] * step];
        }
      }
    }
    return out;
  }
  const dilate = (a, w, h, r) => morph1D(morph1D(a, w, h, r, true, true), w, h, r, true, false);
  const erode = (a, w, h, r) => morph1D(morph1D(a, w, h, r, false, true), w, h, r, false, false);
  const closeOp = (a, w, h, r) => erode(dilate(a, w, h, r), w, h, r);
  const openOp = (a, w, h, r) => dilate(erode(a, w, h, r), w, h, r);
  const toMask = (a) => { const m = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) m[i] = a[i] > 0.5 ? 1 : 0; return m; };

  function boxSizes(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    const s = []; for (let i = 0; i < n; i++) s.push(i < m ? wl : wu); return s;
  }
  function boxBlur1D(src, dst, w, h, r, hor) {
    const n = hor ? w : h, lines = hor ? h : w, step = hor ? 1 : w, inv = 1 / (2 * r + 1);
    for (let L = 0; L < lines; L++) {
      const base = hor ? L * w : L;
      const first = src[base];
      let acc = (r + 1) * first;
      for (let j = 0; j < r; j++) acc += src[base + Math.min(j, n - 1) * step];
      for (let i = 0; i < n; i++) {
        const add = Math.min(i + r, n - 1), rem = i - r - 1;
        acc += src[base + add * step] - (rem >= 0 ? src[base + rem * step] : first);
        dst[base + i * step] = acc * inv;
      }
    }
  }
  // Gaussian blur approximated by three box blurs (edges clamped).
  function gaussBlur(a, w, h, sigma) {
    const s = Float32Array.from(a), t = new Float32Array(w * h);
    if (sigma < 0.5) return s;
    for (const b of boxSizes(sigma, 3)) {
      const r = (b - 1) >> 1; if (r < 1) continue;
      boxBlur1D(s, t, w, h, r, true); boxBlur1D(t, s, w, h, r, false);
    }
    return s;
  }

  // ------------------------------------------------------ distance transform
  // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) with nearest-feature index.
  const BIG = 1e20;
  function dt1d(f, n, d, arg, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let p = v[k];
      let s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) { k--; p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; arg[q] = p;
    }
  }
  function edt(feat, w, h, wantIdx = true) {
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n), arg = new Int32Array(n);
    const G = new Float32Array(w * h), AY = wantIdx ? new Int32Array(w * h) : null;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = feat[y * w + x] ? 0 : BIG;
      dt1d(f, h, d, arg, v, z);
      for (let y = 0; y < h; y++) { G[y * w + x] = d[y]; if (wantIdx) AY[y * w + x] = arg[y]; }
    }
    const d2 = new Float32Array(w * h), idx = wantIdx ? new Int32Array(w * h) : null;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = G[row + x];
      dt1d(f, w, d, arg, v, z);
      for (let x = 0; x < w; x++) {
        d2[row + x] = d[x];
        if (wantIdx) { const ax = arg[x]; idx[row + x] = G[row + ax] >= BIG / 2 ? -1 : AY[row + ax] * w + ax; }
      }
    }
    return { d2, idx };
  }

  // ------------------------------------------------------ connected components
  function labelCC(mask, w, h, conn8) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const areas = [0], boxes = [null];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      n++; let sp = 0; stack[sp++] = i; lab[i] = n;
      let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p - x) / w;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (!conn8 && dx && dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
          }
        }
      }
      areas.push(area); boxes.push([x0, y0, x1, y1]);
    }
    return { lab, n, areas, boxes };
  }
  // Component l with its holes filled, as a mask over the whole image. Returns {mask, area}.
  function fillComponent(cc, l, w, h) {
    const [x0, y0, x1, y1] = cc.boxes[l];
    const bx0 = Math.max(x0 - 1, 0), by0 = Math.max(y0 - 1, 0), bx1 = Math.min(x1 + 1, w - 1), by1 = Math.min(y1 + 1, h - 1);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const outside = new Uint8Array(bw * bh), stack = new Int32Array(bw * bh);
    let sp = 0;
    const push = (x, y) => { const q = y * bw + x; if (!outside[q] && cc.lab[(y + by0) * w + x + bx0] !== l) { outside[q] = 1; stack[sp++] = q; } };
    for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
    for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
    while (sp) {
      const q = stack[--sp], x = q % bw, y = (q - x) / bw;
      if (x > 0) push(x - 1, y); if (x < bw - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < bh - 1) push(x, y + 1);
    }
    const mask = new Uint8Array(w * h); let area = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!outside[y * bw + x]) { mask[(y + by0) * w + x + bx0] = 1; area++; }
    return { mask, area };
  }

  // ------------------------------------------------------------- geometry
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    upper.pop(); lower.pop(); return lower.concat(upper);
  }
  function rowExtremes(mask, w, h, pred) {
    const pts = [];
    for (let y = 0; y < h; y++) {
      let a = -1, b = -1;
      for (let x = 0; x < w; x++) if (pred(mask[y * w + x])) { if (a < 0) a = x; b = x; }
      if (a >= 0) { pts.push([a, y]); if (b !== a) pts.push([b, y]); }
    }
    return pts;
  }
  function fillConvex(mask, w, h, poly) {
    for (let y = 0; y < h; y++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        if ((y < Math.min(ay, by)) || (y > Math.max(ay, by))) continue;
        if (ay === by) { lo = Math.min(lo, ax, bx); hi = Math.max(hi, ax, bx); continue; }
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
      if (lo > hi) continue;
      for (let x = Math.max(0, Math.ceil(lo)); x <= Math.min(w - 1, Math.floor(hi)); x++) mask[y * w + x] = 1;
    }
  }
  const triArea = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  // Largest-area quadrilateral using hull vertices: the page corners.
  function maxAreaQuad(hull) {
    const n = hull.length;
    if (n < 4) return null;
    let best = -1, bestQ = null;
    for (let i = 0; i < n; i++) {
      for (let k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;
        let bj = -1, bjA = -1;
        for (let j = i + 1; j < k; j++) { const a = triArea(hull[i], hull[j], hull[k]); if (a > bjA) { bjA = a; bj = j; } }
        let bl = -1, blA = -1;
        for (let l = k + 1; l < n + i; l++) { const ll = l % n; const a = triArea(hull[k], hull[ll], hull[i]); if (a > blA) { blA = a; bl = ll; } }
        if (bj < 0 || bl < 0) continue;
        if (bjA + blA > best) { best = bjA + blA; bestQ = [hull[i], hull[bj], hull[k], hull[bl]]; }
      }
    }
    return bestQ;
  }
  function solve(A, b) { // Gaussian elimination with partial pivoting; A is n x n (array of rows)
    const n = b.length; A = A.map((r) => r.slice()); b = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
    return x;
  }
  function homographyFrom4(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const hh = solve(A, b); if (!hh) return null;
    return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
  }
  const mul3 = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  };

  // ------------------------------------------------------------- sampling
  function bilin1(a, w, h, x, y, cval) {
    if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return cval;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0, i00 = y0 * w;
    const top = a[i00 + x0] + (a[i00 + x1] - a[i00 + x0]) * fx;
    const bot = a[y1 * w + x0] + (a[y1 * w + x1] - a[y1 * w + x0]) * fx;
    return top + (bot - top) * fy;
  }
  function bilinClamp(a, w, h, x, y) {
    x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    return bilin1(a, w, h, x, y, 0);
  }
  // Bilinear RGB from an RGBA image with clamped edges, writes into out[o..o+2].
  function sampleRGB(img, x, y, out, o) {
    const w = img.w, h = img.h, D = img.data;
    x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const p00 = (y0 * w + x0) * 4, p01 = (y0 * w + x1) * 4, p10 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const t = D[p00 + c] + (D[p01 + c] - D[p00 + c]) * fx;
      const b = D[p10 + c] + (D[p11 + c] - D[p10 + c]) * fx;
      out[o + c] = t + (b - t) * fy;
    }
  }

  // ---------------------------------------------------------- optimisation
  function nelderMead(f, x0, steps, maxEval = 3000, tol = 1e-7) {
    const n = x0.length;
    let pts = [x0.slice()];
    for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += steps[i]; pts.push(p); }
    let vals = pts.map(f), evals = n + 1;
    while (evals < maxEval) {
      const ord = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
      pts = ord.map((i) => pts[i]); vals = ord.map((i) => vals[i]);
      if (Math.abs(vals[n] - vals[0]) <= tol * (Math.abs(vals[0]) + 1e-10)) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
      const lerp = (t) => c.map((cj, j) => cj + t * (pts[n][j] - cj));
      const xr = lerp(-1), fr = f(xr); evals++;
      if (fr < vals[0]) {
        const xe = lerp(-2), fe = f(xe); evals++;
        if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
      else {
        const outside = fr < vals[n];
        const xc = lerp(outside ? -0.5 : 0.5), fc = f(xc); evals++;
        if (fc < (outside ? fr : vals[n])) { pts[n] = xc; vals[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = f(pts[i]); evals++; }
        }
      }
    }
    let bi = 0; for (let i = 1; i <= n; i++) if (vals[i] < vals[bi]) bi = i;
    return { x: pts[bi], f: vals[bi] };
  }
  function minimize(f, x0, steps, rounds = 3) {
    let r = nelderMead(f, x0, steps);
    for (let i = 1; i < rounds; i++) {
      const r2 = nelderMead(f, r.x, steps.map((s) => s * 0.5));
      if (r2.f >= r.f - 1e-9) { if (r2.f < r.f) r = r2; break; }
      r = r2;
    }
    return r;
  }

  // ---------------------------------------------------------- 1. the page
  function median5(a, w, h) {
    const out = new Float32Array(w * h), buf = new Float32Array(25);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); buf[n++] = a[yy * w + xx]; }
      }
      for (let i = 1; i < 25; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
      out[y * w + x] = buf[12];
    }
    return out;
  }
  function largestByEnclosedArea(cc, w, h, top = 5) {
    const ids = []; for (let l = 1; l <= cc.n; l++) ids.push(l);
    ids.sort((a, b) => cc.areas[b] - cc.areas[a]);
    return ids.slice(0, top).map((l) => { const f = fillComponent(cc, l, w, h); return { l, area: f.area, mask: f.mask }; })
      .sort((a, b) => b.area - a.area);
  }
  // Finds the sheet of paper. Works on a 4x reduced copy (kernel sizes tuned for a 2016 px photo).
  function findPage(img) {
    const F = 4, sw = Math.floor(img.w / F), sh = Math.floor(img.h / F), N = sw * sh, D = img.data;
    const V = new Float32Array(N), S = new Float32Array(N);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let sv = 0, ss = 0;
      for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
        const p = ((y * F + dy) * img.w + x * F + dx) * 4, r = D[p], g = D[p + 1], b = D[p + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sv += mx; ss += mx ? (255 * (mx - mn)) / mx : 0;
      }
      V[y * sw + x] = sv / (F * F); S[y * sw + x] = ss / (F * F);
    }
    const vb = median5(V, sw, sh), sb = median5(S, sw, sh);
    // paper: bright & unsaturated; or (in shadow) slightly darker but still unsaturated
    let m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = ((vb[i] > 185 && sb[i] < 60) || (sb[i] < 45 && vb[i] > 165)) ? 1 : 0;
    m = toMask(closeOp(m, sw, sh, 3));
    let cc = labelCC(m, sw, sh, true);
    if (!cc.n) return null;
    let big = largestByEnclosedArea(cc, sw, sh);
    // heavy colouring can split the white margin into two pieces: join them
    if (big.length > 1 && big[1].area > 0.15 * big[0].area) {
      const pts = rowExtremes(cc.lab, sw, sh, (v) => v === big[0].l || v === big[1].l);
      fillConvex(m, sw, sh, convexHull(pts));
      cc = labelCC(m, sw, sh, true);
      big = largestByEnclosedArea(cc, sw, sh);
    }
    let filled = toMask(openOp(big[0].mask, sw, sh, 4));
    cc = labelCC(filled, sw, sh, true);
    if (!cc.n) return null;
    big = largestByEnclosedArea(cc, sw, sh, 3);
    const hull = convexHull(rowExtremes(cc.lab, sw, sh, (v) => v === big[0].l));
    const quad = maxAreaQuad(hull);
    if (!quad) return null;
    const q = quad.map(([x, y]) => [x * F + (F - 1) / 2, y * F + (F - 1) / 2]);
    const sum = q.map((p) => p[0] + p[1]), dif = q.map((p) => p[1] - p[0]);
    const am = (arr, f) => arr.indexOf(f(...arr));
    const tl = q[am(sum, Math.min)], br = q[am(sum, Math.max)], tr = q[am(dif, Math.min)], bl = q[am(dif, Math.max)];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const landscape = (dist(tl, tr) + dist(bl, br)) / 2 > (dist(tl, bl) + dist(tr, br)) / 2;
    const W = landscape ? 2339 : 1654, H = landscape ? 1654 : 2339; // A4 at ~200 dpi
    const corners = [tl, tr, br, bl];
    const areaFrac = (triArea(tl, tr, br) + triArea(br, bl, tl)) / (img.w * img.h);
    const Pinv = homographyFrom4([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], corners);
    if (!Pinv) return null;
    return { corners, W, H, landscape, Pinv, areaFrac };
  }
  function flatV(img, Pinv, W, H) {
    const V = new Float32Array(W * H), px = [0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const z = Pinv[6] * x + Pinv[7] * y + Pinv[8];
      sampleRGB(img, (Pinv[0] * x + Pinv[1] * y + Pinv[2]) / z, (Pinv[3] * x + Pinv[4] * y + Pinv[5]) / z, px, 0);
      V[y * W + x] = Math.max(px[0], px[1], px[2]);
    }
    return V;
  }

  // ---------------------------------------------------------- 2. alignment
  // Printed lines: thin, dark relative to local paper/colour brightness.
  function detectLines(V, W, H, vnMax, bhMin, rLine = 6) {
    const bg = gaussBlur(closeOp(V, W, H, Math.max(15, rLine + 9)), W, H, 8);
    const c13 = closeOp(V, W, H, rLine);
    const lines = new Uint8Array(W * H), B = 35;
    for (let y = B; y < H - B; y++) for (let x = B; x < W - B; x++) {
      const i = y * W + x;
      lines[i] = V[i] / bg[i] < vnMax && c13[i] - V[i] > bhMin ? 1 : 0;
    }
    const { d2, idx } = edt(lines, W, H, true);
    const dist = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) dist[i] = Math.sqrt(d2[i]);
    return { lines, dist, idx, W, H };
  }
  function costH(Hm, pts, n, L, trunc) {
    const { dist, W, H } = L; let s = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      const z = Hm[6] * x + Hm[7] * y + Hm[8];
      const u = (Hm[0] * x + Hm[1] * y + Hm[2]) / z, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / z;
      const d = bilin1(dist, W, H, u, v, trunc);
      s += d < trunc ? d : trunc;
    }
    return s / n;
  }
  const simH = (k, s, tx, ty, th, cx, cy) => {
    const a = (k * Math.PI) / 2 + th, c = Math.cos(a) * s, si = Math.sin(a) * s;
    return [c, -si, tx - c * cx + si * cy, si, c, ty - si * cx - c * cy, 0, 0, 1];
  };
  const hFrom = (x, H0, cx, cy) => {
    const T = [1, 0, cx, 0, 1, cy, 0, 0, 1], Ti = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
    const Dm = [1 + x[0], x[1], x[2], x[3], 1 + x[4], x[5], x[6] * 1e-4, x[7] * 1e-4, 1];
    return mul3(mul3(mul3(H0, T), Dm), Ti);
  };
  // scale at which the template would exactly fit the page, for rotation k * 90 degrees
  const fitScale = (W, H, tpl, k) => (k % 2 === 0 ? Math.min(W / tpl.w, H / tpl.h) : Math.min(W / tpl.h, H / tpl.w));
  async function coarseSearch(L, tpl) {
    const { dist, W, H } = L, pts = tpl.linePts, n = Math.min(800, tpl.nLines);
    const T = 25, dq = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dq[i] = dist[i] < T ? Math.round(dist[i]) : T;
    const cx = tpl.w / 2, cy = tpl.h / 2, sFitK = (k) => fitScale(W, H, tpl, k);
    const ox = new Float32Array(n), oy = new Float32Array(n);
    const offsets = (k, s, m) => {
      const ca = Math.round(Math.cos((k * Math.PI) / 2)), sa = Math.round(Math.sin((k * Math.PI) / 2));
      for (let i = 0; i < m; i++) {
        const px = pts[2 * i] - cx, py = pts[2 * i + 1] - cy;
        ox[i] = s * (ca * px - sa * py); oy[i] = s * (sa * px + ca * py);
      }
    };
    const score = (m, tx, ty) => {
      let c = 0;
      for (let i = 0; i < m; i++) {
        const u = Math.round(tx + ox[i]), v = Math.round(ty + oy[i]);
        c += u >= 0 && v >= 0 && u < W && v < H ? dq[v * W + u] : T;
      }
      return c / m;
    };
    // level 1: sparse grid with a subset of outline points; keep the best candidates
    const n1 = Math.min(250, n), cands = [];
    for (let k = 0; k < 4; k++) {
      for (let sr = 0.62; sr < 1.09; sr += 0.031) {
        const s = sr * sFitK(k); offsets(k, s, n1);
        for (let tx = 0.35 * W; tx < 0.65 * W; tx += 24) for (let ty = 0.3 * H; ty < 0.7 * H; ty += 24)
          cands.push({ c: score(n1, tx, ty), k, s, tx, ty });
      }
      await tick();
    }
    cands.sort((a, b) => a.c - b.c);
    // level 2: dense local search around the best candidates with more points
    let best = { c: Infinity };
    for (const cd of cands.slice(0, 60)) {
      const sStep = 0.0155 * sFitK(cd.k);
      for (const ds of [-sStep, 0, sStep]) {
        const s = cd.s + ds; offsets(cd.k, s, n);
        for (let dx = -16; dx <= 16; dx += 8) for (let dy = -16; dy <= 16; dy += 8) {
          const c = score(n, cd.tx + dx, cd.ty + dy);
          if (c < best.c) best = { c, k: cd.k, s, tx: cd.tx + dx, ty: cd.ty + dy };
        }
      }
    }
    return best;
  }
  function refineHomography(L, tpl, H0, truncs) {
    const cx = tpl.w / 2, cy = tpl.h / 2, n = Math.min(4000, tpl.nLines);
    let Hm = H0;
    for (const t of truncs) {
      const r = minimize((x) => costH(hFrom(x, Hm, cx, cy), tpl.linePts, n, L, t), new Array(8).fill(0),
        [0.004, 0.004, 2, 0.004, 0.004, 2, 0.03, 0.03]);
      Hm = hFrom(r.x, Hm, cx, cy);
    }
    return Hm;
  }
  // Smooth displacement field on a grid 4x coarser than the template (paper curl, lens distortion).
  function makeField(tpl) { const F = 4, gw = Math.ceil(tpl.w / F), gh = Math.ceil(tpl.h / F); return { F, gw, gh, Dx: new Float32Array(gw * gh), Dy: new Float32Array(gw * gh) }; }
  const fieldAt = (fd, G, x, y) => bilinClamp(G, fd.gw, fd.gh, (x - 1.5) / fd.F, (y - 1.5) / fd.F);
  function mapPoint(Hm, fd, x, y, out) {
    const z = Hm[6] * x + Hm[7] * y + Hm[8];
    out[0] = (Hm[0] * x + Hm[1] * y + Hm[2]) / z + (fd ? fieldAt(fd, fd.Dx, x, y) : 0);
    out[1] = (Hm[3] * x + Hm[4] * y + Hm[5]) / z + (fd ? fieldAt(fd, fd.Dy, x, y) : 0);
  }
  async function localRefine(L, tpl, Hm) {
    const fd = makeField(tpl), { F, gw, gh } = fd, n = tpl.nLines, pts = tpl.linePts, { dist, idx, W, H } = L;
    const qx = new Float32Array(n), qy = new Float32Array(n), dd = new Float32Array(n), ddx = new Float32Array(n), ddy = new Float32Array(n);
    const ok = new Uint8Array(n), q = [0, 0];
    const sched = [[18, 60], [14, 45], [12, 38], [10, 32], [8, 26], [6, 22], [5, 18], [4, 15]];
    for (const [radius, sigma] of sched) {
      for (let i = 0; i < n; i++) {
        mapPoint(Hm, fd, pts[2 * i], pts[2 * i + 1], q); qx[i] = q[0]; qy[i] = q[1];
        dd[i] = bilin1(dist, W, H, q[0], q[1], 99);
        const ux = Math.min(W - 1, Math.max(0, Math.round(q[0]))), uy = Math.min(H - 1, Math.max(0, Math.round(q[1])));
        const j = idx[uy * W + ux];
        if (j < 0) { ddx[i] = 0; ddy[i] = 0; dd[i] = 99; } else { ddx[i] = (j % W) - q[0]; ddy[i] = Math.floor(j / W) - q[1]; }
        ok[i] = dd[i] < radius ? 1 : 0;
      }
      let sx, sy;
      for (let rep = 0; rep < 3; rep++) {
        const nx = new Float32Array(gw * gh), ny = new Float32Array(gw * gh), den = new Float32Array(gw * gh);
        for (let i = 0; i < n; i++) if (ok[i]) {
          const c = Math.min(gh - 1, Math.floor(pts[2 * i + 1] / F)) * gw + Math.min(gw - 1, Math.floor(pts[2 * i] / F));
          nx[c] += ddx[i]; ny[c] += ddy[i]; den[c] += 1;
        }
        const bx = gaussBlur(nx, gw, gh, sigma / F), by = gaussBlur(ny, gw, gh, sigma / F), bd = gaussBlur(den, gw, gh, sigma / F);
        sx = new Float32Array(gw * gh); sy = new Float32Array(gw * gh);
        for (let c = 0; c < gw * gh; c++) { const wgt = bd[c] / (bd[c] + 16e-3); sx[c] = (bx[c] / (bd[c] + 1e-9)) * wgt; sy[c] = (by[c] / (bd[c] + 1e-9)) * wgt; }
        const sfd = { F, gw, gh };
        for (let i = 0; i < n; i++) {
          const ex = ddx[i] - fieldAt(sfd, sx, pts[2 * i], pts[2 * i + 1]), ey = ddy[i] - fieldAt(sfd, sy, pts[2 * i], pts[2 * i + 1]);
          ok[i] = dd[i] < radius && Math.hypot(ex, ey) < 3.5 ? 1 : 0;
        }
      }
      for (let c = 0; c < gw * gh; c++) { fd.Dx[c] += sx[c]; fd.Dy[c] += sy[c]; }
      await tick();
    }
    return fd;
  }
  function matchQuality(L, tpl, Hm, fd) {
    const q = [0, 0]; let good = 0;
    for (let i = 0; i < tpl.nLines; i++) {
      mapPoint(Hm, fd, tpl.linePts[2 * i], tpl.linePts[2 * i + 1], q);
      if (bilin1(L.dist, L.W, L.H, q[0], q[1], 99) < 2) good++;
    }
    return good / tpl.nLines;
  }

  // ---------------------------------------------------------- 3. the wrap
  function makeWrap(img, page, Hm, fd, tpl) {
    const tw = tpl.w, th = tpl.h, N = tw * th, alpha = tpl.alpha, P = page.Pinv;
    // a) the drawing in template space (sampled straight from the photo)
    const warped = new Float32Array(N * 3), q = [0, 0];
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      mapPoint(Hm, fd, x, y, q);
      const z = P[6] * q[0] + P[7] * q[1] + P[8];
      sampleRGB(img, (P[0] * q[0] + P[1] * q[1] + P[2]) / z, (P[3] * q[0] + P[4] * q[1] + P[5]) / z, warped, (y * tw + x) * 3);
    }
    for (let i = 0; i < N * 3; i++) warped[i] = Math.round(warped[i]);
    // b) lighting & white balance from the bare paper around the panels
    const out0 = new Uint8Array(N); for (let i = 0; i < N; i++) out0[i] = alpha[i] === 0 ? 1 : 0;
    const outside = erode(out0, tw, th, 4);
    const Vv = new Uint8Array(N), Ss = new Uint8Array(N), hist = new Float64Array(256);
    let nOut = 0;
    for (let i = 0; i < N; i++) {
      const r = warped[3 * i], g = warped[3 * i + 1], b = warped[3 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      Vv[i] = mx; Ss[i] = mx ? Math.round((255 * (mx - mn)) / mx) : 0;
      if (outside[i] > 0.5) { hist[mx]++; nOut++; }
    }
    let p30 = 0; { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.3 * nOut) { p30 = v; break; } } }
    const cand = [];
    for (let y = 0; y < th; y += 2) for (let x = 0; x < tw; x += 2) {
      const i = y * tw + x;
      if (outside[i] > 0.5 && Ss[i] < 45 && Vv[i] > p30) cand.push(i);
    }
    const feats = (x, y) => { const gx = -1 + (2 * x) / (tw - 1), gy = -1 + (2 * y) / (th - 1); return [1, gx, gy, gx * gx, gy * gy, gx * gy]; };
    const light = new Float32Array(N * 3);
    for (let ch = 0; ch < 3; ch++) {
      let coef = null;
      if (cand.length > 500) {
        let use = new Uint8Array(cand.length).fill(1);
        for (let it = 0; it < 3; it++) {
          const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), b = new Array(6).fill(0);
          for (let k = 0; k < cand.length; k++) if (use[k]) {
            const i = cand[k], f = feats(i % tw, Math.floor(i / tw)), yv = warped[3 * i + ch];
            for (let r = 0; r < 6; r++) { b[r] += f[r] * yv; for (let c = 0; c < 6; c++) A[r][c] += f[r] * f[c]; }
          }
          const c2 = solve(A, b); if (!c2) break; coef = c2;
          const res = new Float32Array(cand.length); let s1 = 0, s2 = 0, m = 0;
          for (let k = 0; k < cand.length; k++) {
            const i = cand[k], f = feats(i % tw, Math.floor(i / tw));
            let fit = 0; for (let r = 0; r < 6; r++) fit += coef[r] * f[r];
            res[k] = warped[3 * i + ch] - fit;
            if (use[k]) { s1 += res[k]; s2 += res[k] * res[k]; m++; }
          }
          const sd = Math.sqrt(Math.max(s2 / m - (s1 / m) ** 2, 1e-6));
          for (let k = 0; k < cand.length; k++) use[k] = Math.abs(res[k]) < 2.5 * sd ? 1 : 0;
        }
      }
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        let v = 230;
        if (coef) { const f = feats(x, y); v = 0; for (let r = 0; r < 6; r++) v += coef[r] * f[r]; }
        light[(y * tw + x) * 3 + ch] = Math.max(v, 20);
      }
    }
    const corr = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) corr[i] = Math.min(255, Math.max(0, (warped[i] / light[i]) * 255));
    // c) each panel takes colour only from inside itself; the border band mirrors the texture inward
    const out = new Float32Array(N * 3), filled = new Uint8Array(N);
    const cc = tpl.panels;
    for (let l = 1; l <= cc.n; l++) {
      if (cc.areas[l] < 30) continue;
      const [x0, y0, x1, y1] = cc.boxes[l], pad = 6;
      const bx0 = Math.max(x0 - pad, 0), by0 = Math.max(y0 - pad, 0), bx1 = Math.min(x1 + pad, tw - 1), by1 = Math.min(y1 + pad, th - 1);
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, M = bw * bh;
      const cm = new Uint8Array(M), notc = new Uint8Array(M);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const v = cc.lab[(y + by0) * tw + x + bx0] === l ? 1 : 0; cm[y * bw + x] = v; notc[y * bw + x] = 1 - v; }
      const inner = edt(notc, bw, bh, false).d2;
      let hw2 = 0; for (let i = 0; i < M; i++) if (cm[i] && inner[i] > hw2) hw2 = inner[i];
      const mg = Math.sqrt(hw2) > 20 ? 4 : 2;
      let core = new Uint8Array(M), nc = 0;
      for (let i = 0; i < M; i++) if (cm[i] && inner[i] > mg * mg) { core[i] = 1; nc++; }
      if (nc < 20) { nc = 0; for (let i = 0; i < M; i++) { core[i] = cm[i] && inner[i] > 2 ? 1 : 0; nc += core[i]; } }
      if (nc === 0) core = cm.slice();
      const near = edt(core, bw, bh, true).idx;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i = y * bw + x; if (!cm[i]) continue;
        const j = near[i], ix = j % bw, iy = (j - ix) / bw;
        let rx = 2 * ix - x, ry = 2 * iy - y;
        if (!(rx >= 0 && ry >= 0 && rx < bw && ry < bh) || !core[ry * bw + rx]) { rx = ix; ry = iy; }
        const g = (y + by0) * tw + x + bx0, s = (ry + by0) * tw + rx + bx0;
        out[3 * g] = corr[3 * s]; out[3 * g + 1] = corr[3 * s + 1]; out[3 * g + 2] = corr[3 * s + 2];
        filled[g] = 1;
      }
    }
    // d) outlines, specks and anti-aliased edges take the nearest panel colour
    const near = edt(filled, tw, th, true).idx;
    const rgba = new Uint8ClampedArray(N * 4), check = new Uint8ClampedArray(N * 4), plain = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      let s = i;
      if (alpha[i] > 0 && !filled[i] && near[i] >= 0) s = near[i];
      if (alpha[i] > 0) { rgba[4 * i] = out[3 * s]; rgba[4 * i + 1] = out[3 * s + 1]; rgba[4 * i + 2] = out[3 * s + 2]; }
      rgba[4 * i + 3] = alpha[i];
      plain[4 * i] = warped[3 * i]; plain[4 * i + 1] = warped[3 * i + 1]; plain[4 * i + 2] = warped[3 * i + 2]; plain[4 * i + 3] = 255;
      if (tpl.lineMask[i]) { check[4 * i] = 255; check[4 * i + 1] = 0; check[4 * i + 2] = 110; }
      else { check[4 * i] = plain[4 * i]; check[4 * i + 1] = plain[4 * i + 1]; check[4 * i + 2] = plain[4 * i + 2]; }
      check[4 * i + 3] = 255;
    }
    return { rgba, check, plain };
  }

  // ---------------------------------------------------------- PNG output
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b, s, e) { let c = 0xffffffff; for (let i = s; i < e; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function zlib(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function canvasPNG(rgba, w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function encodePNG(rgba, w, h) {
    if (typeof CompressionStream === "undefined") return canvasPNG(rgba, w, h);
    const stride = w * 4, raw = new Uint8Array((stride + 1) * h);
    const cands = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
    for (let y = 0; y < h; y++) {
      const row = y * stride, prow = row - stride;
      let best = 0, bestS = Infinity;
      for (let t = 0; t < 5; t++) {
        const c = cands[t]; let score = 0;
        for (let i = 0; i < stride; i++) {
          const x = rgba[row + i], a = i >= 4 ? rgba[row + i - 4] : 0, b = y > 0 ? rgba[prow + i] : 0, cc = y > 0 && i >= 4 ? rgba[prow + i - 4] : 0;
          let p = 0;
          if (t === 1) p = a; else if (t === 2) p = b; else if (t === 3) p = (a + b) >> 1;
          else if (t === 4) { const pa = Math.abs(b - cc), pb = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
          const v = (x - p) & 255; c[i] = v; score += v < 128 ? v : 256 - v;
        }
        if (score < bestS) { bestS = score; best = t; }
      }
      raw[y * (stride + 1)] = best; raw.set(cands[best], y * (stride + 1) + 1);
    }
    const idat = await zlib(raw);
    const chunk = (type, data) => {
      const o = new Uint8Array(12 + data.length), dv = new DataView(o.buffer);
      dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
      o.set(data, 8); dv.setUint32(8 + data.length, crc32(o, 4, 8 + data.length)); return o;
    };
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
    const total = parts.reduce((s, p) => s + p.length, 0), png = new Uint8Array(total);
    let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
    return png;
  }
  // Tesla limit is 1 MB: if needed, round colours very slightly until the file fits.
  async function encodeWithinLimit(rgba, w, h, limit = 1000000) {
    let png = null, step = 1;
    for (step of [1, 2, 3, 4, 5, 6, 8]) {
      let a = rgba;
      if (step > 1) {
        a = new Uint8ClampedArray(rgba);
        for (let i = 0; i < a.length; i += 4) if (a[i + 3]) for (let c = 0; c < 3; c++) a[i + c] = Math.min(255, Math.round(a[i + c] / step) * step);
      }
      png = await encodePNG(a, w, h);
      if (png.length < limit) break;
    }
    return { png, step };
  }

  // ---------------------------------------------------------- template
  function prepareTemplate(imgData) {
    const w = imgData.width, h = imgData.height, D = imgData.data, N = w * h;
    const alpha = new Uint8Array(N), lineMask = new Uint8Array(N), interior = new Uint8Array(N);
    const lp = [];
    for (let i = 0; i < N; i++) {
      const a = D[4 * i + 3], m = (D[4 * i] + D[4 * i + 1] + D[4 * i + 2]) / 3;
      alpha[i] = a;
      if (a > 128 && m < 100) { lineMask[i] = 1; lp.push(i); }
      if (a === 255 && m > 200) interior[i] = 1;
    }
    // deterministic shuffle so any prefix is spread over the whole outline
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = lp.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [lp[i], lp[j]] = [lp[j], lp[i]]; }
    const linePts = new Float32Array(lp.length * 2);
    lp.forEach((p, i) => { linePts[2 * i] = p % w; linePts[2 * i + 1] = Math.floor(p / w); });
    const panels = labelCC(interior, w, h, false);
    let transparent = 0; for (let i = 0; i < N; i++) if (alpha[i] === 0) transparent++;
    const problems = [];
    if (transparent < N * 0.1) problems.push("The template has no transparent background, so it doesn't look like a wrap template.");
    if (lp.length < 2000) problems.push("The template has hardly any outline lines.");
    if (panels.n < 3) problems.push("The template has no white panels to fill.");
    // typical printed line thickness (template px): Model Y lines are ~2 px, Cybertruck ~9 px
    const inLine = edt(lineMask.map((v) => 1 - v), w, h, false).d2;
    const half = []; for (let i = 0; i < N; i += 3) if (lineMask[i]) half.push(Math.sqrt(inLine[i]));
    half.sort((a, b) => a - b);
    const lineWidth = half.length ? 2 * half[Math.floor(half.length * 0.9)] : 2;
    return { w, h, alpha, lineMask, linePts, nLines: lp.length, panels, problems, lineWidth };
  }

  // ---------------------------------------------------------- main
  async function run(img, tpl, progress = () => {}) {
    const t0 = performance.now(), times = {};
    const mark = (k) => { times[k] = Math.round(performance.now() - t0); };
    progress("page"); await paint();
    const page = findPage(img);
    if (!page || page.areaFrac < 0.15) throw new Error("NO_PAGE");
    const V = flatV(img, page.Pinv, page.W, page.H);
    mark("page");
    progress("align"); await paint();
    const sEst = 0.95 * Math.max(fitScale(page.W, page.H, tpl, 0), fitScale(page.W, page.H, tpl, 1));
    const rLine = Math.max(6, Math.ceil((tpl.lineWidth * sEst) / 2) + 3);
    const L1 = detectLines(V, page.W, page.H, 0.45, 70, rLine);
    mark("lines");
    await tick();
    const coarse = await coarseSearch(L1, tpl);
    mark("coarse");
    if (coarse.c > 15) throw new Error("NO_MATCH");
    const cx = tpl.w / 2, cy = tpl.h / 2;
    const rs = minimize((x) => costH(simH(coarse.k, x[0], x[1], x[2], x[3], cx, cy), tpl.linePts, Math.min(4000, tpl.nLines), L1, 15),
      [coarse.s, coarse.tx, coarse.ty, 0], [0.01, 4, 4, 0.004]);
    let Hm = simH(coarse.k, rs.x[0], rs.x[1], rs.x[2], rs.x[3], cx, cy);
    mark("similarity");
    Hm = refineHomography(L1, tpl, Hm, [12, 8, 5]);
    mark("align");
    progress("refine"); await paint();
    let fd = await localRefine(L1, tpl, Hm);
    let quality = matchQuality(L1, tpl, Hm, fd), faint = false;
    if (quality < 0.95) {
      // printed lines may be faint in part of the photo: try again with a looser line detector
      const L2 = detectLines(V, page.W, page.H, 0.56, 60, rLine);
      await tick();
      const H2 = refineHomography(L2, tpl, Hm, [8, 5]);
      const fd2 = await localRefine(L2, tpl, H2);
      const qOld = matchQuality(L2, tpl, Hm, fd), qNew = matchQuality(L2, tpl, H2, fd2);
      if (qNew > qOld) { Hm = H2; fd = fd2; quality = qNew; faint = true; } else quality = qOld;
    }
    mark("refine");
    progress("fill"); await paint();
    const wrap = makeWrap(img, page, Hm, fd, tpl);
    mark("fill");
    progress("save"); await paint();
    const { png, step } = await encodeWithinLimit(wrap.rgba, tpl.w, tpl.h);
    mark("save");
    return { png, step, quality, faint, page, rgba: wrap.rgba, check: wrap.check, plain: wrap.plain, w: tpl.w, h: tpl.h, times, rotation: coarse.k };
  }

  return { prepareTemplate, run, encodePNG, _internal: { findPage, edt, gaussBlur, closeOp, labelCC } };
})();
