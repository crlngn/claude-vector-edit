// dc-scan: locate inline <svg> spans inside a .dc.html artboard and splice
// attribute values by byte range, so everything else in the file stays
// byte-identical ({{holes}}, CSS vars, data-props, the DCLogic script).
//
// Plain ESM with no imports: it runs in node (server), in the browser
// (editor) and in the hooks module (publish-back) unchanged.

const GEOMETRY_ATTRS = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polygon: ['points'],
  polyline: ['points'],
  path: ['d'],
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex digits. Identity, not security. */
export function hashText(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The [start, end) of the <x-dc>…</x-dc> fragment (inner text), or null. */
export function findFragment(text) {
  const open = text.search(/<x-dc(\s[^>]*)?>/i)
  if (open < 0) return null
  const openEnd = text.indexOf('>', open) + 1
  const close = text.lastIndexOf('</x-dc>')
  if (close < openEnd) return null
  return { start: openEnd, end: close }
}

// Skips what is not markup to scan: comments, <script>, <style>, <![CDATA[.
function skipOpaque(text, i, limit) {
  if (text.startsWith('<!--', i)) {
    const e = text.indexOf('-->', i + 4)
    return e < 0 ? limit : Math.min(limit, e + 3)
  }
  for (const tag of ['script', 'style']) {
    const re = new RegExp(`^<${tag}(\\s|>)`, 'i')
    if (re.test(text.slice(i, i + tag.length + 2))) {
      const e = text.toLowerCase().indexOf(`</${tag}>`, i)
      return e < 0 ? limit : Math.min(limit, e + tag.length + 3)
    }
  }
  return -1
}

/**
 * Top-level inline <svg> spans inside the fragment, in document order:
 * `{ ordinal, start, end, text, hash }`, absolute offsets into `text`.
 */
export function scanSvgSpans(text) {
  const frag = findFragment(text)
  if (!frag) return []
  const spans = []
  let i = frag.start
  let depth = 0
  let spanStart = -1
  while (i < frag.end) {
    const lt = text.indexOf('<', i)
    if (lt < 0 || lt >= frag.end) break
    const skipped = skipOpaque(text, lt, frag.end)
    if (skipped >= 0) { i = skipped; continue }
    if (/^<svg(\s|>|\/)/i.test(text.slice(lt, lt + 5))) {
      const gt = text.indexOf('>', lt)
      if (gt < 0) break
      const selfClosed = text[gt - 1] === '/'
      if (depth === 0) spanStart = lt
      if (selfClosed) {
        if (depth === 0) pushSpan(spans, text, spanStart, gt + 1)
      } else depth++
      i = gt + 1
      continue
    }
    if (/^<\/svg\s*>/i.test(text.slice(lt, lt + 8))) {
      const gt = text.indexOf('>', lt)
      depth = Math.max(0, depth - 1)
      if (depth === 0 && spanStart >= 0) pushSpan(spans, text, spanStart, gt + 1)
      i = gt + 1
      continue
    }
    i = lt + 1
  }
  return spans
}

function pushSpan(spans, text, start, end) {
  const t = text.slice(start, end)
  spans.push({ ordinal: spans.length, start, end, text: t, hash: hashText(t) })
}

const VOID_HTML = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'wbr', 'source', 'use'])
const TAG_RE = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s"'=<>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g
const ATTR_RE = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/**
 * Element tree of a markup span: each node `{ tag, open:[s,e), close:[s,e)|null,
 * attrs:[{name, value, valueStart, valueEnd, quote}], children }`, offsets relative
 * to the span text. Element children only (text and comments are not nodes),
 * so a child path here matches `element.children` in a parsed DOM.
 */
export function parseTree(spanText) {
  const root = { tag: '#root', open: [0, 0], close: null, attrs: [], children: [] }
  const stack = [root]
  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(spanText))) {
    const [whole, slash, rawTag, attrText, selfSlash] = m
    const tag = rawTag.toLowerCase()
    const s = m.index
    const e = s + whole.length
    if (slash) {
      // close: pop to the matching open tag if any
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack[k].close = [s, e]
          stack.length = k
          break
        }
      }
      continue
    }
    const attrs = []
    const attrBase = s + whole.indexOf(attrText, 1 + rawTag.length)
    ATTR_RE.lastIndex = 0
    let a
    while ((a = ATTR_RE.exec(attrText))) {
      if (a[0].trim() === '') { if (ATTR_RE.lastIndex === a.index) ATTR_RE.lastIndex++; continue }
      const name = a[1]
      let value = null, valueStart = -1, valueEnd = -1, quote = ''
      if (a[2] !== undefined) { value = a[2]; quote = '"' }
      else if (a[3] !== undefined) { value = a[3]; quote = "'" }
      else if (a[4] !== undefined) { value = a[4]; quote = '' }
      if (value !== null) {
        const eq = a[0].indexOf('=')
        const vs = a.index + eq + 1 + a[0].slice(eq + 1).search(/\S/)
        valueStart = attrBase + vs + (quote ? 1 : 0)
        valueEnd = valueStart + value.length
      }
      attrs.push({ name, value, valueStart, valueEnd, quote })
    }
    const node = { tag, open: [s, e], close: null, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfSlash && !VOID_HTML.has(tag)) stack.push(node)
  }
  return root
}

/** The node at a child-index path from the span root (`[]` is the svg itself). */
export function nodeAtPath(tree, path) {
  let node = tree.children[0]
  for (const idx of path) {
    if (!node) return null
    node = node.children[idx]
  }
  return node || null
}

export function attrOf(node, name) {
  return node.attrs.find(a => a.name.toLowerCase() === name.toLowerCase()) || null
}

/**
 * Apply edits to the file text. Each edit:
 *   { svgOrdinal, hash, path: number[], attr: 'd', value: string }
 *   { svgOrdinal, hash, path: number[], convert: { tag: 'path', d: string } }
 * Returns { text, changed: ordinal[] }. Throws { code: 'stale' | 'not_found' | 'locked', ordinal }.
 */
export function applyEdits(text, edits) {
  const spans = scanSvgSpans(text)
  const patches = []
  const changed = new Set()
  for (const edit of edits) {
    const span = spans[edit.svgOrdinal]
    if (!span) throw Object.assign(new Error('no such svg'), { code: 'not_found', ordinal: edit.svgOrdinal })
    if (edit.hash && edit.hash !== span.hash) throw Object.assign(new Error('svg changed on disk'), { code: 'stale', ordinal: edit.svgOrdinal })
    const tree = parseTree(span.text)
    const node = nodeAtPath(tree, edit.path)
    if (!node) throw Object.assign(new Error('no element at path'), { code: 'not_found', ordinal: edit.svgOrdinal })
    if (edit.convert) {
      const d = edit.convert.d
      if (typeof d !== 'string' || !d) throw Object.assign(new Error('convert needs d'), { code: 'not_found', ordinal: edit.svgOrdinal })
      const drop = new Set(GEOMETRY_ATTRS[node.tag] || [])
      const kept = node.attrs.filter(a => !drop.has(a.name.toLowerCase()))
      if (kept.some(a => a.value !== null && a.value.includes('{{')) && false) { /* presentation holes are fine */ }
      const openText = span.text.slice(node.open[0], node.open[1])
      const selfClosed = /\/>$/.test(openText)
      const attrsText = kept.map(a => a.value === null ? a.name : `${a.name}=${a.quote || '"'}${a.value}${a.quote || '"'}`).join(' ')
      const newOpen = `<path${attrsText ? ' ' + attrsText : ''} d="${d}"${selfClosed ? '/>' : '>'}`
      patches.push({ start: span.start + node.open[0], end: span.start + node.open[1], value: newOpen })
      if (node.close) patches.push({ start: span.start + node.close[0], end: span.start + node.close[1], value: '</path>' })
    } else {
      const attr = attrOf(node, edit.attr || 'd')
      if (!attr || attr.value === null) throw Object.assign(new Error('attribute missing'), { code: 'not_found', ordinal: edit.svgOrdinal })
      if (attr.value.includes('{{')) throw Object.assign(new Error('attribute is a template hole'), { code: 'locked', ordinal: edit.svgOrdinal })
      const value = attr.quote === "'" ? String(edit.value).replace(/'/g, '&#39;') : String(edit.value).replace(/"/g, '&quot;')
      patches.push({ start: span.start + attr.valueStart, end: span.start + attr.valueEnd, value })
    }
    changed.add(edit.svgOrdinal)
  }
  patches.sort((a, b) => b.start - a.start)
  for (let k = 1; k < patches.length; k++) {
    if (patches[k].end > patches[k - 1].start) throw Object.assign(new Error('overlapping edits'), { code: 'not_found', ordinal: -1 })
  }
  let out = text
  for (const p of patches) out = out.slice(0, p.start) + p.value + out.slice(p.end)
  return { text: out, changed: [...changed].sort((a, b) => a - b) }
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'marker', 'pattern', 'symbol'])

/** Count editable svg shapes in an artboard: `{ svgs, shapes, locked }`. */
export function countEditable(text) {
  const spans = scanSvgSpans(text)
  let shapes = 0, locked = 0
  const walk = node => {
    for (const c of node.children) {
      if (SKIP_TAGS.has(c.tag)) continue
      if (SHAPE_TAGS.has(c.tag)) {
        const geom = c.tag === 'path' ? ['d'] : GEOMETRY_ATTRS[c.tag]
        const vals = geom.map(k => { const a = attrOf(c, k); return a ? a.value : null })
        if (c.tag === 'path' && vals[0] === null) continue
        if (vals.some(v => typeof v === 'string' && v.includes('{{'))) locked++
        else shapes++
      }
      walk(c)
    }
  }
  for (const span of spans) walk(parseTree(span.text))
  return { svgs: spans.length, shapes, locked }
}

/** The `data-props` JSON of the artboard's DCLogic script, or {}. */
export function readDataProps(text) {
  const m = text.match(/<script[^>]*data-dc-script[^>]*data-props='([^']*)'/i) || text.match(/<script[^>]*data-dc-script[^>]*data-props="([^"]*)"/i)
  if (!m) return {}
  const raw = m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  try { return JSON.parse(raw) } catch { return {} }
}
