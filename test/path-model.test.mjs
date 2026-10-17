import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePath, serialize, precisionOf, samplePoints, splitSegment, removeAnchor, bendSegment, toggleKind, nearestT, segment, shapeToPathD, clone, moveAnchor, toAbsolute } from '../shared/path-model.mjs'

const here = new URL('.', import.meta.url).pathname
const shapes = readFileSync(here + 'fixtures/Shapes.dc.html', 'utf8')
const ds = [...shapes.matchAll(/ d="([^"]+)"/g)].map(m => m[1])

const close = (a, b, tol = 0.01) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol

test('every d in Shapes.dc.html round-trips geometrically', () => {
  assert.ok(ds.length >= 10)
  for (const d of ds) {
    const subs = parsePath(d)
    const d2 = serialize(subs, Math.max(2, precisionOf(d)))
    const a = samplePoints(parsePath(d)), b = samplePoints(parsePath(d2))
    assert.equal(a.length, b.length, d)
    a.forEach((p, i) => assert.ok(close(p, b[i]), `${d} -> ${d2}`))
  }
})

test('closed path merges the duplicate end anchor', () => {
  const subs = parsePath('M0 0L10 0L10 10L0 10L0 0Z')
  assert.equal(subs[0].anchors.length, 4)
  assert.equal(subs[0].closed, true)
  assert.equal(serialize(subs, 0), 'M0 0L10 0L10 10L0 10Z')
})

test('relative, H/V, S, Q, T and A commands normalize', () => {
  const abs = toAbsolute('m10 10 h5 v5 s2 2 4 4 q1 1 2 2 t2 2 a1 1 0 0 1 2 2 z')
  assert.equal(abs[0].cmd, 'M'); assert.deepEqual(abs[0].pts, [10, 10])
  assert.deepEqual(abs[1].pts, [15, 10]); assert.deepEqual(abs[2].pts, [15, 15])
  assert.equal(abs[3].cmd, 'C'); assert.equal(abs[4].cmd, 'C'); assert.equal(abs[5].cmd, 'C'); assert.equal(abs[6].cmd, 'C')
  assert.equal(abs[abs.length - 1].cmd, 'Z')
  const arc = parsePath('M0 0A10 10 0 0 1 20 0')
  const mid = samplePoints(arc, 2)[2]
  assert.ok(close(mid, { x: 10, y: -10 }, 0.05), JSON.stringify(mid))
})

test('split preserves the curve and remove re-joins', () => {
  const d = 'M0 0C10 20 30 20 40 0'
  const subs = parsePath(d)
  const before = samplePoints(subs, 64)
  const idx = splitSegment(subs[0], 0, 0.5)
  assert.equal(idx, 1)
  assert.equal(subs[0].anchors.length, 3)
  const after = samplePoints(subs, 64)
  // the joined sampled polyline must be the same curve: compare against nearest points
  for (const p of before) {
    const best = Math.min(...after.map(q => Math.hypot(p.x - q.x, p.y - q.y)))
    assert.ok(best < 0.5, `${best}`)
  }
  removeAnchor(subs[0], 1)
  assert.equal(subs[0].anchors.length, 2)
  const again = samplePoints(subs, 64)
  before.forEach((p, i) => assert.ok(close(p, again[i], 1.0)))
})

test('bend moves the segment through the dragged point', () => {
  const subs = parsePath('M0 0L100 0')
  bendSegment(subs[0], 0, 0.5, 50, 30)
  const p = samplePoints(subs, 2)[1]
  assert.ok(close(p, { x: 50, y: 30 }, 0.01), JSON.stringify(p))
  assert.ok(subs[0].anchors[0].out && subs[0].anchors[1].in)
})

test('toggle kind seeds smooth handles and nearestT finds the midpoint', () => {
  const subs = parsePath('M0 0L10 0L10 10')
  toggleKind(subs[0], 1)
  const a = subs[0].anchors[1]
  assert.equal(a.kind, 'smooth'); assert.ok(a.in && a.out)
  const seg = segment(parsePath('M0 0L100 0')[0], 0)
  const r = nearestT(seg, { x: 50, y: 5 })
  assert.ok(Math.abs(r.t - 0.5) < 0.01 && Math.abs(r.dist - 5) < 0.01)
})

test('shapes convert to path data', () => {
  assert.equal(shapeToPathD('rect', { x: '1', y: '2', width: '3', height: '4' }), 'M1 2L4 2L4 6L1 6Z')
  assert.equal(shapeToPathD('line', { x1: '0', y1: '0', x2: '5', y2: '5' }), 'M0 0L5 5')
  assert.equal(shapeToPathD('polygon', { points: '0,0 10,0 10,10' }), 'M0 0L10 0L10 10Z')
  const circ = parsePath(shapeToPathD('circle', { cx: '0', cy: '0', r: '10' }))
  for (const p of samplePoints(circ, 8)) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 10) < 0.03)
})

test('move and clone are independent', () => {
  const subs = parsePath('M0 0C1 1 2 2 3 3')
  const copy = clone(subs)
  moveAnchor(subs[0].anchors[0], 5, 5)
  assert.equal(copy[0].anchors[0].x, 0)
  assert.deepEqual(subs[0].anchors[0].out, { x: 6, y: 6 })
})
