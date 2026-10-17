// artboard-vector editor: a point-level SVG editor over a static preview of one
// .dc.html artboard. Edits go back to the server as attribute splices.
import { scanSvgSpans, parseTree, nodeAtPath, attrOf, findFragment, readDataProps, countEditable } from '../shared/dc-scan.mjs'
import * as PM from '../shared/path-model.mjs'

const q = new URLSearchParams(location.search)
const TOKEN = q.get('t') || ''
const api = (p, init) => fetch(p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN), init)

const $ = id => document.getElementById(id)
const stage = $('stage'), world = $('world'), frame = $('frame'), overlay = $('overlay')
const SVG_NS = 'http://www.w3.org/2000/svg'
const EDITABLE = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
const SKIP_CONTAINERS = 'defs,clipPath,mask,marker,pattern,symbol'

const state = {
  board: q.get('board') || '', text: '', spans: [], props: {},
  svgs: [],            // [{ ordinal, hash, el, tree, shapes: [] }]
  shapes: [],          // flat list of editable shapes
  activeSvg: null,
  selection: new Set(), // keys "shapeIndex:sub:anchor"
  tool: 'move',
  zoom: 1, panX: 0, panY: 0,
  undo: [], redo: [],
  dirty: false, saving: false, saveTimer: 0, autosave: false,
  drag: null,
}

// ---------- loading ----------

async function loadBoards() {
  const r = await api('/api/boards'); const j = await r.json()
  const sel = $('board'); sel.innerHTML = ''
  for (const b of j.boards) { const o = document.createElement('option'); o.value = b; o.textContent = b.replace(/\.dc\.html$/, ''); sel.appendChild(o) }
  if (!state.board && j.boards[0]) state.board = j.boards[0]
  sel.value = state.board
  sel.onchange = () => { const u = new URL(location.href); u.searchParams.set('board', sel.value); u.searchParams.delete('select'); location.href = u }
}

async function loadBoard() {
  $('empty').classList.add('show'); $('empty').firstElementChild.textContent = 'Loading ' + state.board + '…'
  const r = await api('/api/board?name=' + encodeURIComponent(state.board))
  if (!r.ok) { $('empty').firstElementChild.textContent = 'Could not load ' + state.board + ' (' + r.status + ')'; return }
  const j = await r.json()
  applyText(j.text, j.spans)
  await renderPreview()
  buildModels()
  fitToWindow()
  preselect()
  $('empty').classList.remove('show')
  setSaveState('saved', 'Loaded')
  const c = countEditable(state.text)
  toast(c.svgs ? `${c.svgs} svg${c.svgs > 1 ? 's' : ''} · ${c.shapes} editable shape${c.shapes === 1 ? '' : 's'}${c.locked ? ` · ${c.locked} locked` : ''}` : 'No inline svg on this artboard')
  restoreUnsaved()
  renderOverlay(); updateStatus()
}

// Unsaved edits survive a pane reload: kept per board in sessionStorage with the span hashes they apply to.
const unsavedKey = () => 'artboard-vector:' + state.board
function stashUnsaved() {
  try {
    if (!state.dirty) { sessionStorage.removeItem(unsavedKey()); return }
    const dirty = state.shapes.filter(s => s.dirty).map(s => ({ index: s.index, hash: s.svg.hash, subs: s.subs, tag: s.tag, originalTag: s.originalTag }))
    sessionStorage.setItem(unsavedKey(), JSON.stringify(dirty))
  } catch {}
}
function restoreUnsaved() {
  let kept = null
  try { kept = JSON.parse(sessionStorage.getItem(unsavedKey()) || 'null') } catch {}
  if (!Array.isArray(kept) || !kept.length) return
  let n = 0
  for (const k of kept) {
    const shape = state.shapes[k.index]
    if (!shape || shape.svg.hash !== k.hash) continue
    shape.subs = k.subs; shape.originalTag = k.originalTag; shape.dirty = true; syncShapeToPreview(shape); n++
  }
  if (n) { state.dirty = true; setSaveState('dirty', 'Unsaved (restored)'); toast(`Restored ${n} unsaved shape edit${n > 1 ? '' : 's'} from before the reload`) ; if (state.autosave) markDirty() }
}

function applyText(text, spans) {
  state.text = text
  state.spans = spans || scanSvgSpans(text).map(s => ({ ordinal: s.ordinal, start: s.start, end: s.end, hash: s.hash }))
  state.props = readDataProps(text)
}

function fragmentParts(text) {
  const f = findFragment(text)
  if (!f) return { helmet: '', body: text }
  let body = text.slice(f.start, f.end)
  let helmet = ''
  body = body.replace(/<helmet(\s[^>]*)?>([\s\S]*?)<\/helmet>/i, (_, _a, inner) => { helmet = inner; return '' })
  return { helmet, body }
}

function fillHoles(html) {
  return html.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, name) => {
    const p = state.props[name]
    if (p && p.default !== undefined && (typeof p.default === 'string' || typeof p.default === 'number')) return String(p.default)
    return ''
  })
}

function renderPreview() {
  const { helmet, body } = fragmentParts(state.text)
  const size = state.props.$preview || {}
  const w = size.width || 1200, h = size.height || 800
  const doc = `<!doctype html><html><head><meta charset="utf-8">${fillHoles(helmet)}<style>html,body{margin:0;overflow:hidden}sc-for,sc-if{display:contents}dc-import{display:inline-block;outline:1px dashed #999;color:#999;font:11px system-ui;padding:4px}</style></head><body>${fillHoles(body)}</body></html>`
  frame.width = w; frame.height = h
  frame.style.width = w + 'px'; frame.style.height = h + 'px'
  overlay.setAttribute('width', w); overlay.setAttribute('height', h)
  overlay.setAttribute('viewBox', `0 0 ${w} ${h}`)
  return new Promise(ok => {
    frame.onload = () => {
      const d = frame.contentDocument
      for (const el of d.querySelectorAll('dc-import')) { const hs = (el.getAttribute('hint-size') || '').split(','); if (hs[0]) el.style.width = hs[0]; if (hs[1]) el.style.height = hs[1]; el.textContent = el.getAttribute('name') || 'import' }
      // let fonts settle a little before measuring
      setTimeout(ok, 60)
    }
    frame.srcdoc = doc
  })
}

function topLevelSvgs(root) {
  return [...root.querySelectorAll('svg')].filter(s => !s.parentElement || !s.parentElement.closest('svg'))
}

function childPath(el, root) {
  const path = []
  let n = el
  while (n && n !== root) { const p = n.parentElement; path.unshift([...p.children].indexOf(n)); n = p }
  return path
}

function buildModels() {
  const doc = frame.contentDocument
  const domSvgs = topLevelSvgs(doc.body)
  state.svgs = []; state.shapes = []
  const n = Math.min(domSvgs.length, state.spans.length)
  if (domSvgs.length !== state.spans.length) toast(`Preview has ${domSvgs.length} svgs, source has ${state.spans.length}; mapping the first ${n}`)
  for (let i = 0; i < n; i++) {
    const span = state.spans[i]
    const spanText = state.text.slice(span.start, span.end)
    const tree = parseTree(spanText)
    const svg = { ordinal: i, hash: span.hash, el: domSvgs[i], tree, shapes: [] }
    for (const el of domSvgs[i].querySelectorAll('path,rect,circle,ellipse,line,polygon,polyline')) {
      if (el.closest(SKIP_CONTAINERS)) continue
      const path = childPath(el, domSvgs[i])
      const node = nodeAtPath(tree, path)
      if (!node || node.tag !== el.tagName.toLowerCase()) continue
      const tag = node.tag
      let d, locked = false
      if (tag === 'path') {
        const a = attrOf(node, 'd'); if (!a || a.value === null) continue
        locked = a.value.includes('{{'); d = a.value
      } else {
        const attrs = {}; for (const a of node.attrs) attrs[a.name.toLowerCase()] = a.value
        locked = Object.values(attrs).some(v => typeof v === 'string' && v.includes('{{') && (PM_GEOM[tag] || []).some(k => attrs[k] === v))
        d = PM.shapeToPathD(tag, attrs)
        if (!d) continue
      }
      const shape = { index: state.shapes.length, svg, el, path, tag, originalTag: tag, locked, precision: Math.max(2, PM.precisionOf(d)), subs: PM.parsePath(d), dirty: false }
      svg.shapes.push(shape); state.shapes.push(shape)
    }
    state.svgs.push(svg)
  }
  state.activeSvg = state.svgs.find(s => s.shapes.some(sh => !sh.locked)) || state.svgs[0] || null
  state.selection.clear(); state.undo = []; state.redo = []
}
const PM_GEOM = { rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polygon: ['points'], polyline: ['points'] }

// Resolve "?select=tid:path" (view-state.md addressing) to a top-level svg ordinal.
function preselect() {
  const sel = q.get('select'); if (!sel) return
  const m = sel.match(/^(\d+):(\d+(?:\/\d+)*)$/); if (!m) return
  const f = findFragment(state.text); if (!f) return
  const tdoc = new DOMParser().parseFromString('<body>' + state.text.slice(f.start, f.end) + '</body>', 'text/html')
  const path = m[2].split('/').map(Number)
  let node = tdoc.body
  for (const i of path) { node = node && node.children[i] }
  if (!node) return
  const svgEl = node.tagName.toLowerCase() === 'svg' ? node : node.closest('svg')
  if (!svgEl) return
  const outer = [...topLevelSvgs(tdoc.body)]
  let top = svgEl; while (top.parentElement && top.parentElement.closest('svg')) top = top.parentElement.closest('svg')
  const ordinal = outer.indexOf(top)
  if (ordinal >= 0 && state.svgs[ordinal]) {
    state.activeSvg = state.svgs[ordinal]
    const shape = state.activeSvg.shapes.find(s => s.el.tagName.toLowerCase() === node.tagName.toLowerCase() && s.path.join('/') === childPath(node, top).join('/'))
    if (shape) for (let si = 0; si < shape.subs.length; si++) for (let ai = 0; ai < shape.subs[si].anchors.length; ai++) state.selection.add(key(shape, si, ai))
    centerOn(state.activeSvg.el)
  }
}

// ---------- geometry helpers ----------

const key = (shape, si, ai) => `${shape.index}:${si}:${ai}`
const unkey = k => { const [s, si, ai] = k.split(':').map(Number); return { shape: state.shapes[s], si, ai } }

function ctmOf(shape) {
  const m = shape.el.getScreenCTM()
  return m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}
const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f })
function invert(m) {
  const det = m.a * m.d - m.b * m.c || 1e-9
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det }
}
const matrixStr = m => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`

/** Pointer event → overlay (iframe px) coordinates. */
function toOverlay(ev) {
  const r = world.getBoundingClientRect()
  return { x: (ev.clientX - r.left) / state.zoom, y: (ev.clientY - r.top) / state.zoom }
}
const toUser = (shape, p) => apply(invert(ctmOf(shape)), p)
const fromUser = (shape, p) => apply(ctmOf(shape), p)

// ---------- rendering ----------

function el(name, attrs, parent) {
  const e = document.createElementNS(SVG_NS, name)
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k])
  if (parent) parent.appendChild(e)
  return e
}

function renderOverlay() {
  overlay.innerHTML = ''
  if (!(state.zoom > 0)) { console.warn('bad zoom', state.zoom); state.zoom = 1 }
  const z = state.zoom
  const hs = 3.5 / z, hr = 2.6 / z
  for (const shape of state.shapes) {
    const m = ctmOf(shape)
    const g = el('g', { transform: matrixStr(m) }, overlay)
    const d = PM.serialize(shape.subs, 4)
    if (shape.locked) { el('path', { d, class: 'outline locked' }, g); continue }
    const active = shape.svg === state.activeSvg
    if (!active) {
      el('path', { d, class: 'shape-hit', 'data-shape': shape.index }, g)
      el('path', { d, class: 'outline', style: 'opacity:.35' }, g)
      continue
    }
    el('path', { d, class: 'outline' }, g)
    // segment hits (inside the transform so the geometry is exact)
    shape.subs.forEach((sub, si) => {
      for (let i = 0; i < PM.segmentCount(sub); i++) {
        const seg = PM.segment(sub, i)
        const sd = `M${seg[0].x} ${seg[0].y}C${seg[1].x} ${seg[1].y} ${seg[2].x} ${seg[2].y} ${seg[3].x} ${seg[3].y}`
        el('path', { d: sd, class: 'seg-hit', 'data-shape': shape.index, 'data-sub': si, 'data-seg': i, style: `stroke-width:${12 / z / Math.hypot(m.a, m.b)}` }, g)
      }
    })
  }
  // anchors and handles in overlay space (constant screen size)
  for (const shape of state.shapes) {
    if (shape.locked || shape.svg !== state.activeSvg) continue
    shape.subs.forEach((sub, si) => sub.anchors.forEach((a, ai) => {
      const k = key(shape, si, ai)
      const selected = state.selection.has(k)
      const p = fromUser(shape, a)
      if (selected || state.tool === 'bend') {
        for (const which of ['in', 'out']) {
          if (!a[which]) continue
          const h = fromUser(shape, a[which])
          el('line', { x1: p.x, y1: p.y, x2: h.x, y2: h.y, class: 'handle-line' }, overlay)
          el('circle', { cx: h.x, cy: h.y, r: hr, class: 'handle', 'data-key': k, 'data-handle': which }, overlay)
        }
      }
      if (a.kind === 'smooth') el('circle', { cx: p.x, cy: p.y, r: hs, class: 'anchor' + (selected ? ' selected' : ''), 'data-key': k }, overlay)
      else el('rect', { x: p.x - hs, y: p.y - hs, width: hs * 2, height: hs * 2, class: 'anchor' + (selected ? ' selected' : ''), 'data-key': k }, overlay)
    }))
  }
  if (state.drag && state.drag.kind === 'marquee') {
    const { x0, y0, x1, y1 } = state.drag
    el('rect', { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), class: 'marquee' }, overlay)
  }
  if (state.drag && state.drag.kind === 'lasso' && state.drag.points.length > 1) {
    el('polygon', { points: state.drag.points.map(p => p.x + ',' + p.y).join(' '), class: 'lasso' }, overlay)
  }
}

function applyView() {
  world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
  $('zoomInfo').textContent = Math.round(state.zoom * 100) + '%'
}

function fitToWindow() {
  const sw = stage.clientWidth, sh = stage.clientHeight
  const w = frame.width, h = frame.height
  if (sw < 120 || sh < 120) { requestAnimationFrame(fitToWindow); return }
  state.zoom = Math.max(0.05, Math.min((sw - 80) / w, (sh - 80) / h, 2))
  state.panX = (sw - w * state.zoom) / 2; state.panY = (sh - h * state.zoom) / 2
  applyView(); renderOverlay()
}

function zoomToActive() { if (state.activeSvg) { centerOn(state.activeSvg.el); renderOverlay() } else fitToWindow() }

function centerOn(svgEl) {
  const r = svgEl.getBoundingClientRect() // iframe px
  const sw = stage.clientWidth, sh = stage.clientHeight
  const target = Math.min(3, Math.max(0.5, Math.min((sw - 160) / Math.max(r.width, 40), (sh - 160) / Math.max(r.height, 40))))
  state.zoom = target
  state.panX = sw / 2 - (r.left + r.width / 2) * target; state.panY = sh / 2 - (r.top + r.height / 2) * target
  applyView()
}

function updateStatus() {
  const n = state.svgs.length, idx = state.activeSvg ? state.activeSvg.ordinal + 1 : 0
  $('svgInfo').textContent = n ? `svg ${idx} of ${n} · ${state.activeSvg ? state.activeSvg.shapes.length : 0} shapes` : 'no inline svg'
  $('selInfo').textContent = state.selection.size ? `${state.selection.size} anchor${state.selection.size > 1 ? 's' : ''} selected` : ''
}

function setSaveState(kind, text) {
  $('dot').className = 'dot ' + kind
  $('saveState').textContent = text
  $('saveDot').classList.toggle('show', kind === 'dirty' || kind === 'error')
}

let toastTimer = 0
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600) }

// ---------- live preview of a shape ----------

function syncShapeToPreview(shape) {
  if (shape.tag !== 'path') {
    // first edit of a basic shape: replace the preview element with a path keeping its presentation
    const p = frame.contentDocument.createElementNS(SVG_NS, 'path')
    for (const a of [...shape.el.attributes]) if (!(PM_GEOM[shape.tag] || []).includes(a.name)) p.setAttribute(a.name, a.value)
    shape.el.replaceWith(p); shape.el = p; shape.tag = 'path'
  }
  shape.el.setAttribute('d', PM.serialize(shape.subs, shape.precision))
}

// ---------- editing ----------

function snapshot() {
  return state.shapes.map(s => ({ subs: PM.clone(s.subs), tag: s.tag }))
}
function pushUndo() {
  state.undo.push(snapshot()); if (state.undo.length > 200) state.undo.shift(); state.redo = []
}
function restore(snap) {
  snap.forEach((s, i) => { const shape = state.shapes[i]; shape.subs = PM.clone(s.subs); if (shape.tag === 'path' || s.tag === 'path') syncShapeToPreview(shape); shape.dirty = true })
  for (const k of [...state.selection]) { const { shape, si, ai } = unkey(k); if (!shape || !shape.subs[si] || !shape.subs[si].anchors[ai]) state.selection.delete(k) }
  markDirty(); renderOverlay(); updateStatus()
}
function undo() { if (!state.undo.length) return; state.redo.push(snapshot()); restore(state.undo.pop()) }
function redo() { if (!state.redo.length) return; state.undo.push(snapshot()); restore(state.redo.pop()) }

function markDirty() {
  if (!state.dirty) reportDirty(true)
  state.dirty = true
  stashUnsaved()
  setSaveState('dirty', 'Unsaved')
  if (state.autosave) { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(save, 1500) }
}

function selectedAnchors() { return [...state.selection].map(unkey).filter(x => x.shape && x.shape.subs[x.si] && x.shape.subs[x.si].anchors[x.ai]) }

function deleteSelected() {
  const items = selectedAnchors(); if (!items.length) return
  pushUndo()
  // delete highest indexes first per subpath
  items.sort((p, r) => p.shape.index - r.shape.index || p.si - r.si || r.ai - p.ai)
  for (const { shape, si, ai } of items) {
    const sub = shape.subs[si]; if (!sub) continue
    PM.removeAnchor(sub, ai)
    if (sub.anchors.length < 2) shape.subs.splice(si, 1)
    shape.dirty = true; syncShapeToPreview(shape)
  }
  state.selection.clear(); markDirty(); renderOverlay(); updateStatus()
}

function toggleKindSelected() {
  const items = selectedAnchors(); if (!items.length) return
  pushUndo()
  for (const { shape, si, ai } of items) { PM.toggleKind(shape.subs[si], ai); shape.dirty = true; syncShapeToPreview(shape) }
  markDirty(); renderOverlay()
}

function selectAll() {
  if (!state.activeSvg) return
  for (const shape of state.activeSvg.shapes) if (!shape.locked) shape.subs.forEach((sub, si) => sub.anchors.forEach((a, ai) => state.selection.add(key(shape, si, ai))))
  renderOverlay(); updateStatus()
}

function nudge(dx, dy) {
  const items = selectedAnchors(); if (!items.length) return
  pushUndo()
  for (const { shape, si, ai } of items) {
    const inv = invert(ctmOf(shape))
    const dUser = { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy }
    PM.moveAnchor(shape.subs[si].anchors[ai], dUser.x, dUser.y); shape.dirty = true; syncShapeToPreview(shape)
  }
  markDirty(); renderOverlay()
}

// ---------- pointer handling ----------

let spaceHeld = false
let lastAnchorClick = { key: '', at: 0 }
overlay.addEventListener('contextmenu', e => e.preventDefault())
stage.addEventListener('pointerdown', onPointerDown)
overlay.addEventListener('dblclick', e => {
  const t = e.target
  if (!(t.classList && t.classList.contains('anchor'))) return
  e.preventDefault(); state.drag = null
  state.selection.clear(); state.selection.add(t.dataset.key); toggleKindSelected(); updateStatus()
})
window.addEventListener('pointermove', onPointerMove)
window.addEventListener('pointerup', onPointerUp)
stage.addEventListener('wheel', e => {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const factor = Math.exp(-e.deltaY * 0.01)
    const nz = Math.min(16, Math.max(0.1, state.zoom * factor))
    state.panX = mx - (mx - state.panX) * (nz / state.zoom); state.panY = my - (my - state.panY) * (nz / state.zoom)
    state.zoom = nz
  } else { state.panX -= e.deltaX; state.panY -= e.deltaY }
  applyView(); renderOverlay()
}, { passive: false })

function onPointerDown(e) {
  try { stage.setPointerCapture(e.pointerId) } catch {}
  if (e.button === 1 || spaceHeld || e.button === 2) { state.drag = { kind: 'pan', x: e.clientX, y: e.clientY, px: state.panX, py: state.panY }; return }
  if (e.button !== 0) return
  $('menu').classList.remove('open')
  const t = e.target
  const p = toOverlay(e)
  if (t.classList && t.classList.contains('anchor')) {
    const k = t.dataset.key
    const now = performance.now()
    if (lastAnchorClick.key === k && now - lastAnchorClick.at < 400) {
      lastAnchorClick = { key: '', at: 0 }
      state.selection.clear(); state.selection.add(k); toggleKindSelected(); updateStatus(); return
    }
    lastAnchorClick = { key: k, at: now }
    if (e.shiftKey) { if (state.selection.has(k)) state.selection.delete(k); else state.selection.add(k) }
    else if (!state.selection.has(k)) { state.selection.clear(); state.selection.add(k) }
    beginMove(p, true)
    renderOverlay(); updateStatus(); return
  }
  if (t.classList && t.classList.contains('handle')) {
    const { shape, si, ai } = unkey(t.dataset.key)
    pushUndo()
    state.drag = { kind: 'handle', shape, si, ai, which: t.dataset.handle, breakSmooth: e.altKey }
    return
  }
  if (t.classList && t.classList.contains('seg-hit')) {
    const shape = state.shapes[Number(t.dataset.shape)], si = Number(t.dataset.sub), seg = Number(t.dataset.seg)
    const sub = shape.subs[si]
    const u = toUser(shape, p)
    const near = PM.nearestT(PM.segment(sub, seg), u)
    pushUndo()
    if (state.tool === 'bend') {
      state.drag = { kind: 'bend', shape, si, seg, t: near.t }
      state.selection.clear(); renderOverlay(); return
    }
    const idx = PM.splitSegment(sub, seg, near.t)
    shape.dirty = true; syncShapeToPreview(shape)
    state.selection.clear(); state.selection.add(key(shape, si, idx))
    markDirty(); beginMove(p, false); renderOverlay(); updateStatus(); return
  }
  if (t.classList && t.classList.contains('shape-hit')) {
    const shape = state.shapes[Number(t.dataset.shape)]
    state.activeSvg = shape.svg; state.selection.clear(); centerOn(shape.svg.el); renderOverlay(); updateStatus(); return
  }
  // empty space: marquee or lasso
  if (!e.shiftKey) state.selection.clear()
  if (state.tool === 'lasso') state.drag = { kind: 'lasso', points: [p], additive: e.shiftKey }
  else state.drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey }
  renderOverlay(); updateStatus()
}

function beginMove(p, deferUndo) {
  const items = selectedAnchors()
  state.drag = { kind: 'move', start: p, last: p, items: items.map(it => ({ ...it, origin: PM.clone([it.shape.subs[it.si]])[0].anchors[it.ai] })), moved: false, deferUndo }
}

function onPointerMove(e) {
  const d = state.drag; if (!d) return
  if (d.kind === 'pan') { state.panX = d.px + (e.clientX - d.x); state.panY = d.py + (e.clientY - d.y); applyView(); renderOverlay(); return }
  const p = toOverlay(e)
  if (d.kind === 'marquee') { d.x1 = p.x; d.y1 = p.y; renderOverlay(); return }
  if (d.kind === 'lasso') { d.points.push(p); renderOverlay(); return }
  if (d.kind === 'move') {
    if (!d.moved) { if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * state.zoom < 2) return; d.moved = true; if (d.deferUndo) pushUndo() }
    const touched = new Set()
    for (const it of d.items) {
      const inv = invert(ctmOf(it.shape))
      const dx = p.x - d.start.x, dy = p.y - d.start.y
      const du = { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy }
      const a = it.shape.subs[it.si] && it.shape.subs[it.si].anchors[it.ai]; if (!a) continue
      a.x = it.origin.x + du.x; a.y = it.origin.y + du.y
      if (it.origin.in) a.in = { x: it.origin.in.x + du.x, y: it.origin.in.y + du.y }
      if (it.origin.out) a.out = { x: it.origin.out.x + du.x, y: it.origin.out.y + du.y }
      touched.add(it.shape)
    }
    for (const s of touched) { s.dirty = true; syncShapeToPreview(s) }
    renderOverlay(); return
  }
  if (d.kind === 'handle') {
    const u = toUser(d.shape, p)
    PM.setHandle(d.shape.subs[d.si].anchors[d.ai], d.which, u.x, u.y, d.breakSmooth)
    d.shape.dirty = true; syncShapeToPreview(d.shape); renderOverlay(); return
  }
  if (d.kind === 'bend') {
    const u = toUser(d.shape, p)
    PM.bendSegment(d.shape.subs[d.si], d.seg, d.t, u.x, u.y)
    d.shape.dirty = true; syncShapeToPreview(d.shape); renderOverlay(); return
  }
}

function onPointerUp(e) {
  const d = state.drag; if (!d) return
  state.drag = null
  if (d.kind === 'marquee' || d.kind === 'lasso') {
    const inside = d.kind === 'marquee'
      ? pt => pt.x >= Math.min(d.x0, d.x1) && pt.x <= Math.max(d.x0, d.x1) && pt.y >= Math.min(d.y0, d.y1) && pt.y <= Math.max(d.y0, d.y1)
      : pt => pointInPolygon(pt, d.points)
    const big = d.kind === 'marquee' ? Math.abs(d.x1 - d.x0) > 2 || Math.abs(d.y1 - d.y0) > 2 : d.points.length > 3
    if (big && state.activeSvg) for (const shape of state.activeSvg.shapes) {
      if (shape.locked) continue
      shape.subs.forEach((sub, si) => sub.anchors.forEach((a, ai) => { if (inside(fromUser(shape, a))) state.selection.add(key(shape, si, ai)) }))
    }
    renderOverlay(); updateStatus(); return
  }
  if (d.kind === 'move' && d.moved) markDirty()
  if (d.kind === 'move' && !d.moved && !d.deferUndo) markDirty()
  if (d.kind === 'handle' || d.kind === 'bend') markDirty()
  renderOverlay()
}

function pointInPolygon(p, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// ---------- saving ----------

function reportDirty(dirty) { api('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board: state.board, dirty }) }).catch(() => {}) }

async function save() {
  clearTimeout(state.saveTimer)
  if (state.saving) { state.saveTimer = setTimeout(save, 500); return }
  const dirtyShapes = state.shapes.filter(s => s.dirty)
  if (!dirtyShapes.length) { state.dirty = false; setSaveState('saved', 'Saved'); return }
  state.saving = true; setSaveState('dirty', 'Saving…')
  const edits = dirtyShapes.map(s => {
    const d = PM.serialize(s.subs, s.precision)
    const base = { svgOrdinal: s.svg.ordinal, hash: s.svg.hash, path: s.path }
    return s.originalTag !== 'path' ? { ...base, convert: { tag: 'path', d } } : { ...base, attr: 'd', value: d }
  })
  try {
    const r = await api('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board: state.board, edits }) })
    if (r.status === 409) { setSaveState('error', 'Changed on disk'); toast('The board changed on disk. Reloading it; your unsaved edit is kept in undo.'); await reloadKeepingView(); return }
    if (!r.ok) { const j = await r.json().catch(() => ({})); setSaveState('error', 'Save failed'); toast('Save failed: ' + (j.message || j.error || r.status)); return }
    const j = await r.json()
    state.text = j.text; state.spans = j.spans
    // refresh span hashes and source trees without rebuilding the DOM
    for (const svg of state.svgs) {
      const span = state.spans[svg.ordinal]; if (!span) continue
      svg.hash = span.hash; svg.tree = parseTree(state.text.slice(span.start, span.end))
    }
    for (const s of dirtyShapes) { s.dirty = false; s.originalTag = 'path' }
    state.dirty = state.shapes.some(s => s.dirty)
    stashUnsaved()
    if (!state.dirty) reportDirty(false)
    setSaveState('saved', 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  } catch (e) {
    setSaveState('error', 'Save failed'); toast('Save failed: ' + e.message)
  } finally { state.saving = false }
}

async function reloadKeepingView() {
  const keep = [...state.selection], act = state.activeSvg ? state.activeSvg.ordinal : 0
  const r = await api('/api/board?name=' + encodeURIComponent(state.board)); const j = await r.json()
  applyText(j.text, j.spans); await renderPreview(); buildModels()
  state.activeSvg = state.svgs[act] || state.activeSvg
  for (const k of keep) { const { shape, si, ai } = unkey(k); if (shape && shape.subs[si] && shape.subs[si].anchors[ai]) state.selection.add(k) }
  setSaveState('saved', 'Reloaded'); renderOverlay(); updateStatus()
}

// ---------- toolbar, menu, keys ----------

function setTool(name) {
  state.tool = name
  for (const b of document.querySelectorAll('#tools .tool')) b.classList.toggle('active', b.dataset.tool === name)
  $('hint').textContent = name === 'move' ? 'Click or drag anchors · shift adds · click an edge to add a point'
    : name === 'lasso' ? 'Draw around anchors to select · shift adds'
    : 'Drag an edge to bend · drag handles · alt breaks smooth · double-click toggles corner/smooth'
  renderOverlay()
}
for (const b of document.querySelectorAll('#tools .tool')) b.addEventListener('click', () => setTool(b.dataset.tool))
$('more').addEventListener('click', e => { e.stopPropagation(); $('menu').classList.toggle('open') })
document.addEventListener('click', e => { if (!$('menu').contains(e.target)) $('menu').classList.remove('open') })
$('menu').addEventListener('click', e => {
  const act = e.target.closest('button') && e.target.closest('button').dataset.act
  if (act === 'toggle-kind') toggleKindSelected()
  if (act === 'select-all') selectAll()
  if (act === 'delete') deleteSelected()
  if (act === 'fit') fitToWindow()
  if (act === 'zoom-active') zoomToActive()
  if (act) $('menu').classList.remove('open')
})
$('autosave').addEventListener('click', () => { state.autosave = !state.autosave; $('autosave').setAttribute('aria-pressed', String(state.autosave)); $('autosave').classList.toggle('on', state.autosave); if (state.autosave && state.dirty) markDirty() })
$('save').addEventListener('click', () => save())
$('zoomActive').addEventListener('click', () => zoomToActive())
$('reload').addEventListener('click', () => reloadKeepingView())

window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return
  if (e.code === 'Space') { spaceHeld = true; stage.style.cursor = 'grab'; e.preventDefault(); return }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
  if (e.key === 'Escape') { state.selection.clear(); state.drag = null; renderOverlay(); updateStatus(); return }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return }
  if (e.key === 'v' || e.key === 'V') setTool('move')
  if (e.key === 'l' || e.key === 'L') setTool('lasso')
  if (e.key === 'b' || e.key === 'B') setTool('bend')
  if (e.key === '0') fitToWindow()
  if (e.key === '1') zoomToActive()
  const step = (e.shiftKey ? 10 : 1) / state.zoom
  if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0) }
  if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0) }
  if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -step) }
  if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, step) }
})
window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceHeld = false; stage.style.cursor = '' } })
window.addEventListener('resize', () => renderOverlay())
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = '' } })

// ---------- go ----------
loadBoards().then(loadBoard).catch(e => { $('empty').classList.add('show'); $('empty').firstElementChild.textContent = 'Error: ' + e.message })
