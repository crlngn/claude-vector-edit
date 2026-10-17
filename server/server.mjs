// artboard-vector local editor server. Zero dependencies, loopback only.
//   node server.mjs --root <root> --token <token> [--port 0]
// Prints one JSON line per event on stdout: listening, saved, error.
import http from 'node:http'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSvgSpans, applyEdits } from '../shared/dc-scan.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true'])
  return acc
}, []))
const ROOT = resolve(args.root || process.cwd())
const TOKEN = args.token || ''
const PORT = Number(args.port || 0)
const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'web')
const SHARED = join(HERE, '..', 'shared')

const say = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

const boardName = raw => {
  const name = String(raw || '')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html$/.test(name) || name.includes('..')) return null
  return name
}
const boardPath = name => join(ROOT, 'project', name)

async function listBoards() {
  const dir = join(ROOT, 'project')
  let order = []
  try { order = JSON.parse(await readFile(join(dir, 'canvas.json'), 'utf8')).order || [] } catch {}
  let files = []
  try { files = (await readdir(dir)).filter(f => f.endsWith('.dc.html')) } catch {}
  const seen = new Set()
  const out = []
  for (const f of [...order, ...files]) if (!seen.has(f) && files.includes(f)) { seen.add(f); out.push(f) }
  return out
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function serveStatic(res, base, rel) {
  const file = resolve(base, '.' + rel)
  if (!file.startsWith(base)) return json(res, 404, { error: 'not found' })
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(data)
  } catch { json(res, 404, { error: 'not found' }) }
}

const readBody = req => new Promise((ok, no) => {
  let s = ''
  req.on('data', c => { s += c; if (s.length > 8e6) { no(new Error('too large')); req.destroy() } })
  req.on('end', () => ok(s)); req.on('error', no)
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  const isStatic = p.startsWith('/web/') || p.startsWith('/shared/')
  if (!isStatic && TOKEN && url.searchParams.get('t') !== TOKEN && req.headers['x-token'] !== TOKEN) return json(res, 401, { error: 'token' })
  try {
    if (p === '/' || p === '/edit') return serveStatic(res, WEB, '/editor.html')
    if (p.startsWith('/web/')) return serveStatic(res, WEB, p.slice(4))
    if (p.startsWith('/shared/')) return serveStatic(res, SHARED, p.slice(7))
    if (p === '/api/health') return json(res, 200, { ok: true, root: ROOT })
    if (p === '/api/shutdown' && req.method === 'POST') { json(res, 200, { ok: true }); say({ event: 'shutdown' }); setTimeout(() => process.exit(0), 50); return }
    if (p === '/api/state' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}')
      const name = boardName(body.board)
      if (!name) return json(res, 400, { error: 'bad board name' })
      say({ event: 'dirty', board: name, path: boardPath(name), dirty: !!body.dirty })
      return json(res, 200, { ok: true })
    }
    if (p === '/api/boards') return json(res, 200, { root: ROOT, boards: await listBoards() })
    if (p === '/api/board') {
      const name = boardName(url.searchParams.get('name'))
      if (!name) return json(res, 400, { error: 'bad board name' })
      const text = await readFile(boardPath(name), 'utf8')
      const spans = scanSvgSpans(text).map(s => ({ ordinal: s.ordinal, start: s.start, end: s.end, hash: s.hash }))
      const { mtimeMs } = await stat(boardPath(name))
      return json(res, 200, { name, text, spans, mtimeMs })
    }
    if (p === '/api/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}')
      const name = boardName(body.board)
      if (!name) return json(res, 400, { error: 'bad board name' })
      const file = boardPath(name)
      const text = await readFile(file, 'utf8')
      let out
      try { out = applyEdits(text, body.edits || []) } catch (e) {
        if (e.code === 'stale') return json(res, 409, { error: 'stale', ordinal: e.ordinal })
        return json(res, 422, { error: e.code || 'bad edit', message: e.message, ordinal: e.ordinal })
      }
      await writeFile(file, out.text, 'utf8')
      const spans = scanSvgSpans(out.text).map(s => ({ ordinal: s.ordinal, start: s.start, end: s.end, hash: s.hash }))
      say({ event: 'saved', board: name, path: file, svgOrdinals: out.changed, at: new Date().toISOString() })
      return json(res, 200, { ok: true, spans, text: out.text })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    say({ event: 'error', message: String(e && e.message || e) })
    return json(res, 500, { error: String(e && e.message || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => say({ event: 'listening', port: server.address().port, root: ROOT }))
