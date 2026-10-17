// path-model: SVG path data as editable anchors with handles.
//
//   subpath = { closed: boolean, anchors: Anchor[] }
//   Anchor  = { x, y, in: {x,y}|null, out: {x,y}|null, kind: 'corner'|'smooth' }
//
// `in` is the control point of the segment arriving at the anchor, `out` the
// one leaving it. A segment between anchors a and b is a line when both
// a.out and b.in are null, else a cubic (a, a.out ?? a, b.in ?? b, b).
// Plain ESM, no imports: node, browser and hooks share it.

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/** Tokenize `d` into absolute commands: [{cmd:'M'|'L'|'C'|'Z', pts:[x,y,...]}]. */
export function toAbsolute(d) {
  const out = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g
  let cx = 0, cy = 0, sx = 0, sy = 0
  let lastCmd = '', lastC2 = null, lastQ = null
  let m
  while ((m = re.exec(d))) {
    const cmd = m[1]
    const nums = (m[2].match(NUM) || []).map(Number)
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    let i = 0
    const take = n => { const v = nums.slice(i, i + n); i += n; return v }
    if (C === 'Z') {
      out.push({ cmd: 'Z', pts: [] }); cx = sx; cy = sy; lastCmd = 'Z'; lastC2 = null; lastQ = null
      continue
    }
    let first = true
    while (i < nums.length || (first && nums.length === 0 && C !== 'Z')) {
      first = false
      if (C === 'M') {
        const [x, y] = take(2); if (x === undefined) break
        const ax = rel ? cx + x : x, ay = rel ? cy + y : y
        // subsequent pairs after M are implicit L
        if (out.length && out[out.length - 1].cmd === 'M' && lastCmd === 'M' && i > 2) out.push({ cmd: 'L', pts: [ax, ay] })
        else { out.push({ cmd: 'M', pts: [ax, ay] }); sx = ax; sy = ay }
        cx = ax; cy = ay; lastCmd = 'M'; lastC2 = null; lastQ = null
      } else if (C === 'L') {
        const [x, y] = take(2); if (x === undefined) break
        cx = rel ? cx + x : x; cy = rel ? cy + y : y
        out.push({ cmd: 'L', pts: [cx, cy] }); lastC2 = null; lastQ = null
      } else if (C === 'H') {
        const [x] = take(1); if (x === undefined) break
        cx = rel ? cx + x : x
        out.push({ cmd: 'L', pts: [cx, cy] }); lastC2 = null; lastQ = null
      } else if (C === 'V') {
        const [y] = take(1); if (y === undefined) break
        cy = rel ? cy + y : y
        out.push({ cmd: 'L', pts: [cx, cy] }); lastC2 = null; lastQ = null
      } else if (C === 'C') {
        const p = take(6); if (p.length < 6) break
        const [x1, y1, x2, y2, x, y] = rel ? [cx + p[0], cy + p[1], cx + p[2], cy + p[3], cx + p[4], cy + p[5]] : p
        out.push({ cmd: 'C', pts: [x1, y1, x2, y2, x, y] }); lastC2 = [x2, y2]; lastQ = null; cx = x; cy = y
      } else if (C === 'S') {
        const p = take(4); if (p.length < 4) break
        const [x2, y2, x, y] = rel ? [cx + p[0], cy + p[1], cx + p[2], cy + p[3]] : p
        const [x1, y1] = lastC2 ? [2 * cx - lastC2[0], 2 * cy - lastC2[1]] : [cx, cy]
        out.push({ cmd: 'C', pts: [x1, y1, x2, y2, x, y] }); lastC2 = [x2, y2]; lastQ = null; cx = x; cy = y
      } else if (C === 'Q') {
        const p = take(4); if (p.length < 4) break
        const [qx, qy, x, y] = rel ? [cx + p[0], cy + p[1], cx + p[2], cy + p[3]] : p
        pushQuad(out, cx, cy, qx, qy, x, y); lastQ = [qx, qy]; lastC2 = null; cx = x; cy = y
      } else if (C === 'T') {
        const p = take(2); if (p.length < 2) break
        const [x, y] = rel ? [cx + p[0], cy + p[1]] : p
        const [qx, qy] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy]
        pushQuad(out, cx, cy, qx, qy, x, y); lastQ = [qx, qy]; lastC2 = null; cx = x; cy = y
      } else if (C === 'A') {
        const p = take(7); if (p.length < 7) break
        const [rx, ry, rot, large, sweep] = p
        const x = rel ? cx + p[5] : p[5], y = rel ? cy + p[6] : p[6]
        for (const c of arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y)) out.push({ cmd: 'C', pts: c })
        lastC2 = null; lastQ = null; cx = x; cy = y
      }
      lastCmd = C
    }
  }
  return out
}

function pushQuad(out, x0, y0, qx, qy, x, y) {
  out.push({ cmd: 'C', pts: [x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y] })
}

/** Standard endpoint-to-center arc conversion, then cubic pieces of at most 90°. */
export function arcToCubics(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return []
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]
  const phi = rotDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda) }
  const sign = large !== sweep ? 1 : -1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx)
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)
  const step = dt / n
  const res = []
  for (let k = 0; k < n; k++) {
    const a1 = t1 + k * step, a2 = a1 + step
    const alpha = Math.sin(step) * (Math.sqrt(4 + 3 * Math.tan(step / 2) ** 2) - 1) / 3
    const pt = a => [cx + rx * Math.cos(a) * cp - ry * Math.sin(a) * sp, cy + rx * Math.cos(a) * sp + ry * Math.sin(a) * cp]
    const dv = a => [-rx * Math.sin(a) * cp - ry * Math.cos(a) * sp, -rx * Math.sin(a) * sp + ry * Math.cos(a) * cp]
    const p1 = pt(a1), p2 = pt(a2), d1 = dv(a1), d2 = dv(a2)
    res.push([p1[0] + alpha * d1[0], p1[1] + alpha * d1[1], p2[0] - alpha * d2[0], p2[1] - alpha * d2[1], p2[0], p2[1]])
  }
  return res
}

const EPS = 1e-6
const same = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

/** Parse `d` into subpaths of anchors. */
export function parsePath(d) {
  const cmds = toAbsolute(d)
  const subs = []
  let cur = null
  for (const c of cmds) {
    if (c.cmd === 'M') {
      cur = { closed: false, anchors: [{ x: c.pts[0], y: c.pts[1], in: null, out: null, kind: 'corner' }] }
      subs.push(cur)
    } else if (!cur) {
      continue
    } else if (c.cmd === 'L') {
      cur.anchors.push({ x: c.pts[0], y: c.pts[1], in: null, out: null, kind: 'corner' })
    } else if (c.cmd === 'C') {
      const prev = cur.anchors[cur.anchors.length - 1]
      const [x1, y1, x2, y2, x, y] = c.pts
      prev.out = same({ x: x1, y: y1 }, prev) ? null : { x: x1, y: y1 }
      cur.anchors.push({ x, y, in: same({ x: x2, y: y2 }, { x, y }) ? null : { x: x2, y: y2 }, out: null, kind: 'corner' })
    } else if (c.cmd === 'Z') {
      cur.closed = true
      const a = cur.anchors
      if (a.length > 1 && same(a[0], a[a.length - 1])) {
        const last = a.pop()
        a[0].in = last.in
      }
      cur = null
    }
  }
  for (const s of subs) for (const a of s.anchors) a.kind = isSmooth(a) ? 'smooth' : 'corner'
  return subs
}

export function isSmooth(a) {
  if (!a.in || !a.out) return false
  const ux = a.x - a.in.x, uy = a.y - a.in.y, vx = a.out.x - a.x, vy = a.out.y - a.y
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
  if (lu < EPS || lv < EPS) return false
  const cos = (ux * vx + uy * vy) / (lu * lv)
  return cos > Math.cos(2 * Math.PI / 180)
}

/** Decimal places used in `d` (capped at 3), at least 1 when any decimals appear. */
export function precisionOf(d) {
  let p = 0
  for (const n of d.match(NUM) || []) {
    const dot = n.indexOf('.')
    if (dot >= 0) p = Math.max(p, Math.min(3, n.length - dot - 1 - (n.match(/[eE]/) ? 0 : 0)))
  }
  return p
}

function fmt(v, p) {
  const s = Number(v.toFixed(p)).toString()
  return s === '-0' ? '0' : s
}

/** Serialize subpaths back to `d` with M/L/C/Z. */
export function serialize(subs, precision = 2) {
  const f = v => fmt(v, precision)
  let d = ''
  for (const s of subs) {
    const a = s.anchors
    if (!a.length) continue
    d += `M${f(a[0].x)} ${f(a[0].y)}`
    const n = s.closed ? a.length : a.length - 1
    for (let i = 0; i < n; i++) {
      const p = a[i], q = a[(i + 1) % a.length]
      const closingLine = s.closed && i === a.length - 1 && !p.out && !q.in
      if (closingLine) continue
      if (!p.out && !q.in) d += `L${f(q.x)} ${f(q.y)}`
      else {
        const c1 = p.out || p, c2 = q.in || q
        d += `C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(q.x)} ${f(q.y)}`
      }
    }
    if (s.closed) d += 'Z'
  }
  return d
}

/** Cubic control points of segment i (from anchor i to the next). */
export function segment(sub, i) {
  const a = sub.anchors, p = a[i], q = a[(i + 1) % a.length]
  return [p, p.out || p, q.in || q, q]
}

export function segmentCount(sub) {
  return sub.closed ? sub.anchors.length : Math.max(0, sub.anchors.length - 1)
}

export function pointAt([p0, p1, p2, p3], t) {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

/** Nearest parameter t on a cubic to point `pt` (coarse sampling then refinement). */
export function nearestT(seg, pt) {
  let best = 0, bestD = Infinity
  for (let k = 0; k <= 32; k++) {
    const t = k / 32, q = pointAt(seg, t), d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2
    if (d < bestD) { bestD = d; best = t }
  }
  let lo = Math.max(0, best - 1 / 32), hi = Math.min(1, best + 1 / 32)
  for (let k = 0; k < 24; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
    const q1 = pointAt(seg, m1), q2 = pointAt(seg, m2)
    const d1 = (q1.x - pt.x) ** 2 + (q1.y - pt.y) ** 2, d2 = (q2.x - pt.x) ** 2 + (q2.y - pt.y) ** 2
    if (d1 < d2) hi = m2; else lo = m1
  }
  const t = (lo + hi) / 2, q = pointAt(seg, t)
  return { t, point: q, dist: Math.hypot(q.x - pt.x, q.y - pt.y) }
}

/** Move an anchor and its handles by (dx, dy). */
export function moveAnchor(a, dx, dy) {
  a.x += dx; a.y += dy
  if (a.in) { a.in.x += dx; a.in.y += dy }
  if (a.out) { a.out.x += dx; a.out.y += dy }
}

/** Insert an anchor on segment i at t (de Casteljau split, shape preserved). Returns the new index. */
export function splitSegment(sub, i, t) {
  const [p0, p1, p2, p3] = segment(sub, i)
  const a = sub.anchors, p = a[i], q = a[(i + 1) % a.length]
  const isLine = !p.out && !q.in
  const lerp = (u, v) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t })
  const m01 = lerp(p0, p1), m12 = lerp(p1, p2), m23 = lerp(p2, p3)
  const m012 = lerp(m01, m12), m123 = lerp(m12, m23), mid = lerp(m012, m123)
  const node = { x: mid.x, y: mid.y, in: isLine ? null : m012, out: isLine ? null : m123, kind: isLine ? 'corner' : 'smooth' }
  if (!isLine) { p.out = m01; q.in = m23 }
  a.splice(i + 1, 0, node)
  return i + 1
}

/** Remove anchor i, joining its neighbours with one cubic fitted to the old curve (tangents kept). */
export function removeAnchor(sub, i) {
  const a = sub.anchors
  if ((a.length <= 2 && !sub.closed) || a.length <= 1) { a.splice(i, 1); return }
  const n = a.length
  const pi = (i - 1 + n) % n, ni = (i + 1) % n
  const prev = a[pi], next = a[ni], gone = a[i]
  const hadCurve = gone.in || gone.out || prev.out || next.in
  const firstOpen = !sub.closed && i === 0, lastOpen = !sub.closed && i === n - 1
  if (hadCurve && !firstOpen && !lastOpen) {
    // sample the two old segments, then fit one cubic with fixed tangent directions
    const s1 = [prev, prev.out || prev, gone.in || gone, gone], s2 = [gone, gone.out || gone, next.in || next, next]
    const pts = []
    for (let k = 0; k <= 16; k++) pts.push(pointAt(s1, k / 16))
    for (let k = 1; k <= 16; k++) pts.push(pointAt(s2, k / 16))
    const dirOut = prev.out ? norm(prev.out.x - prev.x, prev.out.y - prev.y) : norm(gone.x - prev.x, gone.y - prev.y)
    const dirIn = next.in ? norm(next.in.x - next.x, next.in.y - next.y) : norm(gone.x - next.x, gone.y - next.y)
    const fit = fitCubic(prev, dirOut, next, dirIn, pts)
    prev.out = { x: prev.x + dirOut.x * fit.alpha, y: prev.y + dirOut.y * fit.alpha }
    next.in = { x: next.x + dirIn.x * fit.beta, y: next.y + dirIn.y * fit.beta }
  }
  a.splice(i, 1)
  if (firstOpen && a[0]) a[0].in = null
  if (lastOpen && a[a.length - 1]) a[a.length - 1].out = null
}

// Least-squares handle lengths for a cubic P0 + α·t1 … P3 + β·t2 through chord-parameterized points.
function fitCubic(p0, t1, p3, t2, pts) {
  let total = 0
  const u = [0]
  for (let k = 1; k < pts.length; k++) { total += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y); u.push(total) }
  let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0
  for (let k = 0; k < pts.length; k++) {
    const t = total ? u[k] / total : 0, v = 1 - t
    const b1 = 3 * v * v * t, b2 = 3 * v * t * t
    const a1 = { x: t1.x * b1, y: t1.y * b1 }, a2 = { x: t2.x * b2, y: t2.y * b2 }
    const base = { x: v * v * v * p0.x + b1 * p0.x + b2 * p3.x + t * t * t * p3.x, y: v * v * v * p0.y + b1 * p0.y + b2 * p3.y + t * t * t * p3.y }
    const r = { x: pts[k].x - base.x, y: pts[k].y - base.y }
    c11 += a1.x * a1.x + a1.y * a1.y; c12 += a1.x * a2.x + a1.y * a2.y; c22 += a2.x * a2.x + a2.y * a2.y
    x1 += a1.x * r.x + a1.y * r.y; x2 += a2.x * r.x + a2.y * r.y
  }
  const det = c11 * c22 - c12 * c12
  const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y) / 3
  if (Math.abs(det) < 1e-9) return { alpha: chord, beta: chord }
  const alpha = (x1 * c22 - x2 * c12) / det, beta = (c11 * x2 - c12 * x1) / det
  return { alpha: alpha > 0 ? alpha : chord, beta: beta > 0 ? beta : chord }
}

function norm(x, y) { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l } }

/** Bend segment i so that its point at t moves to (x, y), moving both control points equally. */
export function bendSegment(sub, i, t, x, y) {
  const a = sub.anchors, p = a[i], q = a[(i + 1) % a.length]
  if (!p.out && !q.in) {
    p.out = { x: p.x + (q.x - p.x) / 3, y: p.y + (q.y - p.y) / 3 }
    q.in = { x: p.x + 2 * (q.x - p.x) / 3, y: p.y + 2 * (q.y - p.y) / 3 }
  }
  if (!p.out) p.out = { x: p.x, y: p.y }
  if (!q.in) q.in = { x: q.x, y: q.y }
  const cur = pointAt([p, p.out, q.in, q], t)
  const w = 3 * t * (1 - t) || 1e-6
  const dx = (x - cur.x) / w, dy = (y - cur.y) / w
  p.out.x += dx; p.out.y += dy; q.in.x += dx; q.in.y += dy
  mirrorIfSmooth(p, 'out'); mirrorIfSmooth(q, 'in')
}

/** Set one handle; a smooth anchor mirrors the other handle's direction. */
export function setHandle(a, which, x, y, breakSmooth = false) {
  a[which] = { x, y }
  if (breakSmooth) a.kind = 'corner'
  else mirrorIfSmooth(a, which)
}

function mirrorIfSmooth(a, moved) {
  if (a.kind !== 'smooth') return
  const other = moved === 'out' ? 'in' : 'out'
  if (!a[other] || !a[moved]) return
  const len = Math.hypot(a[other].x - a.x, a[other].y - a.y)
  const d = norm(a[moved].x - a.x, a[moved].y - a.y)
  a[other] = { x: a.x - d.x * len, y: a.y - d.y * len }
}

/** Toggle corner/smooth. Smooth seeds handles along the chord when missing. */
export function toggleKind(sub, i) {
  const a = sub.anchors, node = a[i]
  if (node.kind === 'smooth') { node.kind = 'corner'; return }
  const n = a.length
  const prev = a[(i - 1 + n) % n], next = a[(i + 1) % n]
  const hasPrev = sub.closed || i > 0, hasNext = sub.closed || i < n - 1
  const dir = norm((hasNext ? next.x : node.x) - (hasPrev ? prev.x : node.x), (hasNext ? next.y : node.y) - (hasPrev ? prev.y : node.y))
  const lenIn = hasPrev ? Math.hypot(node.x - prev.x, node.y - prev.y) / 3 : 0
  const lenOut = hasNext ? Math.hypot(next.x - node.x, next.y - node.y) / 3 : 0
  if (hasPrev) node.in = { x: node.x - dir.x * lenIn, y: node.y - dir.y * lenIn }
  if (hasNext) node.out = { x: node.x + dir.x * lenOut, y: node.y + dir.y * lenOut }
  node.kind = 'smooth'
}

/** Path data for a basic shape element's attributes. */
export function shapeToPathD(tag, attrs, precision = 2) {
  const n = k => parseFloat(attrs[k]) || 0
  const f = v => fmt(v, precision)
  switch (tag) {
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height')
      let rx = attrs.rx !== undefined ? n('rx') : (attrs.ry !== undefined ? n('ry') : 0)
      let ry = attrs.ry !== undefined ? n('ry') : rx
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2)
      if (!rx && !ry) return `M${f(x)} ${f(y)}L${f(x + w)} ${f(y)}L${f(x + w)} ${f(y + h)}L${f(x)} ${f(y + h)}Z`
      const k = 0.5522847498
      return `M${f(x + rx)} ${f(y)}L${f(x + w - rx)} ${f(y)}C${f(x + w - rx + rx * k)} ${f(y)} ${f(x + w)} ${f(y + ry - ry * k)} ${f(x + w)} ${f(y + ry)}` +
        `L${f(x + w)} ${f(y + h - ry)}C${f(x + w)} ${f(y + h - ry + ry * k)} ${f(x + w - rx + rx * k)} ${f(y + h)} ${f(x + w - rx)} ${f(y + h)}` +
        `L${f(x + rx)} ${f(y + h)}C${f(x + rx - rx * k)} ${f(y + h)} ${f(x)} ${f(y + h - ry + ry * k)} ${f(x)} ${f(y + h - ry)}` +
        `L${f(x)} ${f(y + ry)}C${f(x)} ${f(y + ry - ry * k)} ${f(x + rx - rx * k)} ${f(y)} ${f(x + rx)} ${f(y)}Z`
    }
    case 'circle': case 'ellipse': {
      const cx = n('cx'), cy = n('cy')
      const rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry')
      const k = 0.5522847498
      return `M${f(cx + rx)} ${f(cy)}C${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}` +
        `C${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)}` +
        `C${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}` +
        `C${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)}Z`
    }
    case 'line':
      return `M${f(n('x1'))} ${f(n('y1'))}L${f(n('x2'))} ${f(n('y2'))}`
    case 'polygon': case 'polyline': {
      const pts = (String(attrs.points || '').match(NUM) || []).map(Number)
      let d = ''
      for (let i = 0; i + 1 < pts.length; i += 2) d += (i ? 'L' : 'M') + f(pts[i]) + ' ' + f(pts[i + 1])
      return d + (tag === 'polygon' ? 'Z' : '')
    }
    default:
      return null
  }
}

export function clone(subs) {
  return subs.map(s => ({ closed: s.closed, anchors: s.anchors.map(a => ({ x: a.x, y: a.y, in: a.in && { ...a.in }, out: a.out && { ...a.out }, kind: a.kind })) }))
}

/** Sample points along every segment (for tests and hit testing). */
export function samplePoints(subs, per = 16) {
  const pts = []
  for (const s of subs) for (let i = 0; i < segmentCount(s); i++) {
    const seg = segment(s, i)
    for (let k = 0; k <= per; k++) pts.push(pointAt(seg, k / per))
  }
  return pts
}
