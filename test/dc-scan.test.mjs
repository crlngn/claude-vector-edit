import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scanSvgSpans, parseTree, nodeAtPath, attrOf, applyEdits, hashText, readDataProps } from '../shared/dc-scan.mjs'

const here = new URL('.', import.meta.url).pathname
const shapes = readFileSync(here + 'fixtures/Shapes.dc.html', 'utf8')

test('finds the five top-level svgs of Shapes.dc.html in order', () => {
  const spans = scanSvgSpans(shapes)
  assert.equal(spans.length, 5)
  assert.ok(spans[0].text.startsWith('<svg width="0" height="0"'))
  assert.ok(spans[1].text.includes('M14 1H226L239 14'))
  for (const s of spans) assert.equal(shapes.slice(s.start, s.end), s.text)
})

test('element tree paths match DOM child indexing', () => {
  const span = scanSvgSpans(shapes)[1]
  const tree = parseTree(span.text)
  const first = nodeAtPath(tree, [0])
  assert.equal(first.tag, 'path')
  assert.equal(attrOf(first, 'd').value, 'M14 1H226L239 14V136L226 149H14L1 136V14Z')
  assert.equal(nodeAtPath(tree, [1]).tag, 'path')
  assert.equal(nodeAtPath(tree, [2]), null)
})

test('applyEdits splices only the d value and keeps the rest byte-identical', () => {
  const spans = scanSvgSpans(shapes)
  const span = spans[1]
  const out = applyEdits(shapes, [{ svgOrdinal: 1, hash: span.hash, path: [0], attr: 'd', value: 'M0 0L10 10Z' }])
  const old = 'M14 1H226L239 14V136L226 149H14L1 136V14Z'
  assert.equal(out.changed.join(), '1')
  assert.equal(out.text.length, shapes.length - old.length + 'M0 0L10 10Z'.length)
  assert.equal(out.text.slice(0, span.start), shapes.slice(0, span.start))
  assert.equal(out.text.slice(out.text.length - (shapes.length - span.end)), shapes.slice(span.end))
  assert.ok(out.text.includes('<path d="M0 0L10 10Z" stroke="url(#sg)"'))
  // re-scan yields a new hash for that span only
  const again = scanSvgSpans(out.text)
  assert.notEqual(again[1].hash, span.hash)
  assert.equal(again[2].hash, spans[2].hash)
})

test('stale hash is refused', () => {
  assert.throws(() => applyEdits(shapes, [{ svgOrdinal: 1, hash: 'deadbeef', path: [0], attr: 'd', value: 'M0 0' }]), e => e.code === 'stale')
})

test('a template hole in d is locked', () => {
  const doc = `<x-dc><svg viewBox="0 0 1 1"><path d="{{gd}}"/></svg></x-dc>`
  const [span] = scanSvgSpans(doc)
  assert.throws(() => applyEdits(doc, [{ svgOrdinal: 0, hash: span.hash, path: [0], attr: 'd', value: 'M0 0' }]), e => e.code === 'locked')
})

test('nested svg, sc-for, comments and style are handled', () => {
  const doc = `<x-dc><helmet><style>svg{}</style></helmet><!-- <svg> --><div><sc-for list="{{xs}}" as="x"><svg viewBox="0 0 2 2"><g><svg><rect x="0" y="0" width="1" height="1"/></svg></g><circle cx="1" cy="1" r="1"></circle></svg></sc-for></div></x-dc><script>'<svg></svg>'</script>`
  const spans = scanSvgSpans(doc)
  assert.equal(spans.length, 1)
  const tree = parseTree(spans[0].text)
  assert.equal(nodeAtPath(tree, [0]).tag, 'g')
  assert.equal(nodeAtPath(tree, [0, 0, 0]).tag, 'rect')
  assert.equal(nodeAtPath(tree, [1]).tag, 'circle')
  const out = applyEdits(doc, [{ svgOrdinal: 0, hash: spans[0].hash, path: [1], convert: { tag: 'path', d: 'M2 1A1 1 0 1 1 0 1A1 1 0 1 1 2 1Z' } }])
  assert.ok(out.text.includes('<path d="M2 1A1 1 0 1 1 0 1A1 1 0 1 1 2 1Z"></path>'))
  assert.ok(!out.text.includes('<circle'))
  const out2 = applyEdits(doc, [{ svgOrdinal: 0, hash: spans[0].hash, path: [0, 0, 0], convert: { tag: 'path', d: 'M0 0H1V1H0Z' } }])
  assert.ok(out2.text.includes('<path d="M0 0H1V1H0Z"/>'))
})

test('convert keeps non-geometry attributes verbatim', () => {
  const doc = `<x-dc><svg><rect class="a" x="1" y="2" width="3" height="4" style="fill: var(--x, #000)" rx="1"></rect></svg></x-dc>`
  const [span] = scanSvgSpans(doc)
  const out = applyEdits(doc, [{ svgOrdinal: 0, hash: span.hash, path: [0], convert: { tag: 'path', d: 'M1 2' } }])
  assert.ok(out.text.includes('<path class="a" style="fill: var(--x, #000)" d="M1 2"></path>'))
})

test('hash is stable and data-props parse', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
  assert.deepEqual(readDataProps(shapes).$preview, { width: 1200, height: 1000 })
})
