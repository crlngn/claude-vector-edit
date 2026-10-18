import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { ArtboardVectorCanvas, ArtboardVectorServer, ArtboardVectorBoard, ArtboardVectorPending } from '../types'
import { scanSvgSpans, countEditable } from '../shared/dc-scan.mjs'

const PLUGIN = 'artboard-vector'
const COMMAND = 'vector-edit'
const canvasRef = atom({ plugin: 'artboard-vector', key: 'canvas' } as const, null as ArtboardVectorCanvas | null)
const serverRef = atom({ plugin: 'artboard-vector', key: 'server' } as const, null as ArtboardVectorServer | null)
const pendingRef = atom({ plugin: 'artboard-vector', key: 'pendingPublish' } as const, null as ArtboardVectorPending | null)
const notesRef = atom({ plugin: 'artboard-vector', key: 'notes' } as const, [] as string[])
// Server starts are queued here and run by a loop rooted in session.start, so the child outlives whatever dispatch asked for it.
const serverRequests: { root: string; ok: (s: ArtboardVectorServer) => void; no: (e: Error) => void }[] = []
// A comment opens the editor only when it starts with `/vector-edit` or `vector:` (anything after is ignored).
const TRIGGER = /^\s*(\/vector-edit\b|vector:)/i
const boardsFamily = { plugin: 'artboard-vector', key: 'boards' } as const

type $ = EngineInterface
type ServerEvent =
  | { event: 'listening'; port: number; root: string }
  | { event: 'saved'; board: string; path: string; svgOrdinals: number[]; at: string }
  | { event: 'dirty'; board: string; path: string; dirty: boolean }
  | { event: 'shutdown' }
  | { event: 'error'; message: string }

const isBoardName = (s: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html$/.test(s)
const artifactId = (url: string) => (url.match(/\/artifact\/([A-Za-z0-9-]+)/) || [])[1] || 'canvas'

/** `root` of a Design canvas publish/read from the Artifact tool's arguments. */
function rootFromArtifactArgs(e: { root?: string; file_path?: string; out_dir?: string }): string | null {
  if (e.root) return e.root
  for (const p of [e.file_path, e.out_dir]) {
    if (!p) continue
    const i = p.indexOf('/project/')
    if (i > 0) return p.slice(0, i)
  }
  return null
}

/** The viewer's live selection from the last `<artifact-view-context>` block, if any. */
async function viewContext($: $): Promise<{ board?: string; select?: string }> {
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const block = m.text.match(/<artifact-view-context[^>]*>([\s\S]*?)<\/artifact-view-context>/)
    if (!block) continue
    try {
      const data = JSON.parse(block[1])
      const ctx = data && typeof data === 'object' ? (data.context || data) : {}
      const boards: unknown = ctx.selectedArtboards || ctx.visibleArtboards
      const first = Array.isArray(boards) && typeof boards[0] === 'string' ? decodeURIComponent(boards[0]) : undefined
      const sel: unknown = Array.isArray(ctx.selected) && typeof ctx.selected[0] === 'string' ? ctx.selected[0] : undefined
      const m2 = typeof sel === 'string' ? sel.match(/^(.+?\.dc\.html)#(\d+:\d+(?:\/\d+)*)$/) : null
      return { board: m2 ? decodeURIComponent(m2[1]) : first, select: m2 ? m2[2] : undefined }
    } catch { return {} }
  }
  return {}
}

async function nodeBinary($: $): Promise<string> {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) if (await $.fs.exists(p)) return p
  return 'node'
}

async function serverAlive($: $, server: ArtboardVectorServer | null, root: string): Promise<boolean> {
  if (!server || server.root !== root) return false
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${server.port}/api/health?t=${encodeURIComponent(server.token)}`)
    return r.ok
  } catch { return false }
}

async function stopServer($: $, server: ArtboardVectorServer | null) {
  if (!server) return
  try { await $.http.fetch(`http://127.0.0.1:${server.port}/api/shutdown?t=${encodeURIComponent(server.token)}`, { method: 'POST' }) } catch {}
  await update($, serverRef, () => null)
}

/** Ask the session.start runner to start the editor server for `root`; resolves once it listens. */
function startServer($: $, root: string): Promise<ArtboardVectorServer> {
  return new Promise<ArtboardVectorServer>((ok, no) => {
    serverRequests.push({ root, ok, no })
    void $.clock.sleep(8000).then(() => no(new Error('the editor server did not start in 8 s')))
  })
}

/** Runs one editor server to its end: spawns it, relays its events, and resolves the request once it listens. */
async function runServer($: $, req: { root: string; ok: (s: ArtboardVectorServer) => void; no: (e: Error) => void }) {
  const token = crypto.randomUUID().replace(/-/g, '')
  const argv = [await nodeBinary($), `${$.plugin.root}/server/server.mjs`, '--root', req.root, '--token', token]
  const stream = $.process.spawn({ argv, cwd: req.root })
  let buffer = ''
  try {
    for await (const chunk of stream) {
      if (!('stream' in chunk)) break
      if (chunk.stream !== 'stdout') { $.ui.log(`${PLUGIN} server: ${chunk.text.trim()}`, { to: 'debug' }); continue }
      buffer += chunk.text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1)
        if (!line) continue
        let ev: ServerEvent
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.event === 'listening') {
          const s = { port: ev.port, token, root: req.root }
          await update($, serverRef, () => s)
          req.ok(s)
        } else if (ev.event === 'saved') {
          await update($, { ...boardsFamily, id: ev.board }, () => ({ dirty: false, lastSaved: ev.at }))
          await publishBack($, ev)
        } else if (ev.event === 'dirty') {
          await update($, { ...boardsFamily, id: ev.board }, (b?: ArtboardVectorBoard) => ({ dirty: ev.dirty, lastSaved: b?.lastSaved ?? null }))
        } else if (ev.event === 'error') {
          $.ui.toast(`Vector editor: ${ev.message}`)
        }
      }
    }
  } catch (e) {
    req.no(e instanceof Error ? e : new Error(String(e)))
  } finally {
    await update($, serverRef, () => null)
  }
}

/** Republish the saved board to the canvas through the Artifact tool, retrying once over a stale refusal. */
async function publishBack($: $, saved: { board: string; path: string; svgOrdinals: number[]; at: string }) {
  const canvas = await read($, canvasRef)
  if (!canvas) return
  const attempt = () => $.tool.call({ tool: 'Artifact', action: 'publish', url: canvas.url, root: canvas.root, file_path: saved.path })
  let ran = await attempt()
  if (ran.deny === undefined && ran.isError !== true) {
    $.ui.toast(`${saved.board} saved to the canvas`)
    $.ui.status(`vector: ${saved.board} saved`)
    await update($, notesRef, notes => [...notes, `${PLUGIN}: the user edited project/${saved.board} by hand in the vector editor (${saved.at}); it was republished to the canvas. Re-read the file before changing it.`])
    return
  }
  const text = (ran.deny ?? ran.text ?? '').toString()
  $.ui.log(`${PLUGIN}: publish of ${saved.board} failed: ${text.slice(0, 400)}`, { to: 'debug' })
  const stale = /re-?read|refus|changed|newer|conflict|latest version/i.test(text) && ran.deny === undefined
  if (stale) {
    const mine = await $.fs.read(saved.path)
    // The tool wants the artifact itself viewed at its latest version, then the file re-read.
    await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url })
    const fresh = await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url, path: `project/${saved.board}`, out_dir: canvas.root })
    if (fresh.deny === undefined && fresh.isError !== true) {
      const theirs = await $.fs.read(saved.path)
      const mineSpans = scanSvgSpans(mine), theirSpans = scanSvgSpans(theirs)
      let merged = theirs
      for (const ordinal of [...saved.svgOrdinals].sort((a, b) => b - a)) {
        const t = theirSpans[ordinal], m = mineSpans[ordinal]
        if (t && m) merged = merged.slice(0, t.start) + m.text + merged.slice(t.end)
      }
      await $.fs.write(saved.path, merged)
      ran = await attempt()
      if (ran.deny === undefined && ran.isError !== true) { $.ui.toast(`${saved.board} merged over a canvas edit and saved`); return }
    }
  }
  await update($, pendingRef, () => ({ url: canvas.url, root: canvas.root, filePath: saved.path, board: saved.board, at: saved.at }))
  $.ui.toast(`${saved.board} saved locally; the canvas publish needs Claude (send any message). Reason: ${text.slice(0, 120)}`)
}

/** Why a write to `filePath` should wait, while the editor holds unsaved changes for that board; null when it may go ahead. */
async function guard($: $, filePath: string | undefined, what: string): Promise<string | null> {
  const canvas = await read($, canvasRef)
  if (!canvas || !filePath || !filePath.startsWith(canvas.root + '/project/')) return null
  const board = filePath.slice(canvas.root.length + '/project/'.length)
  const { value } = await $.state.get({ ...boardsFamily, id: board })
  return value && value.dirty ? `${PLUGIN}: the vector editor has unsaved changes for ${board}; wait for its auto-save (or press Save there) before ${what}.` : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Vector-edit the shapes of a /design artboard in the browser pane', argumentHint: '[canvas words] [artboard] [--list] [--canvases]' })
    let kept: ArtboardVectorCanvas | undefined
    try { kept = (await $.store.get('canvas')) as ArtboardVectorCanvas | undefined } catch {}
    if (kept && kept.url && kept.root && !(await read($, canvasRef))) await update($, canvasRef, () => kept)
    // Serve queued server starts from here, so each child lives as long as the session (or the module), not one dispatch.
    void (async () => {
      for (;;) {
        await $.clock.sleep(250)
        const req = serverRequests.shift()
        if (req) await runServer($, req)
      }
    })()
    return next(e)
  })

  // Learn the canvas (url + local root) from the design skill's own Artifact calls.
  on('tool.call', { tool: 'Artifact' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const url = (e as { url?: string }).url
    const root = rootFromArtifactArgs(e as { root?: string; file_path?: string; out_dir?: string })
    if (url && root && /\/artifact\//.test(url)) {
      const uuid = ((ran.text || '').match(/Artifact ([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1]
      const prior = await read($, canvasRef)
      const canvas: ArtboardVectorCanvas = { url, root, uuid: uuid ?? (prior && prior.url === url ? prior.uuid : undefined) }
      await update($, canvasRef, () => canvas)
      try { await $.store.set('canvas', canvas) } catch {}
    }
    return ran
  })

  // While the editor holds unsaved changes for a board, keep Claude from writing that file or publishing the canvas.
  for (const tool of ['Edit', 'Write', 'MultiEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const why = await guard($, (e as { file_path?: string }).file_path, 'editing it')
      return why ? { deny: why } : next(e)
    }).catch(($, e, next) => next(e))
  }
  on('tool.call', { tool: 'Artifact' }, async ($, e, next) => {
    const args = e as { action?: string; file_path?: string }
    if (args.action !== 'publish' && args.action !== undefined) return next(e)
    const why = await guard($, args.file_path, 'publishing')
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => next(e))

  // Hand Claude the notes a save left, and a publish the mod could not make itself.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const notes = await read($, notesRef)
    const pending = await read($, pendingRef)
    const lines = [...notes]
    if (pending) lines.push(`${PLUGIN}: the user saved project/${pending.board} in the vector editor at ${pending.at} but the canvas was not republished. Publish it now with the Artifact tool: { action: "publish", url: "${pending.url}", root: "${pending.root}", file_path: "${pending.filePath}" }; if the publish is refused as stale, read that file from the canvas first, re-apply the svg changes, and publish again.`)
    if (lines.length) {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: lines.join('\n') }] } })
      await update($, notesRef, () => [])
      await update($, pendingRef, () => null)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    let canvas = await read($, canvasRef)
    let board: string | undefined
    let wantList = false
    let wantCanvasList = false
    const query: string[] = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w === '--list') { wantList = true; continue }
      if (w === '--canvases') { wantCanvasList = true; continue }
      if (w === '--url' && words[i + 1]) { canvas = { url: words[++i], root: '' }; continue }
      if (w === '--root' && words[i + 1]) { canvas = { url: canvas?.url ?? '', root: words[++i] }; continue }
      if (/^https?:\/\//.test(w)) { canvas = { url: w, root: canvas && canvas.url === w ? canvas.root : '' }; continue }
      if (isBoardName(w)) board = w
      else query.push(w)
    }
    // Free words: first try them as a canvas title (when no canvas is bound, or they clearly name another one), then as an artboard.
    if (wantCanvasList || !canvas || !canvas.url || query.length) {
      const canvases = await listCanvases($)
      if (wantCanvasList) return { text: canvases.length ? `Your Design canvases:\n${canvases.map(c => `  ${c.title}  ${c.url}`).join('\n')}\n\nOpen one with /${COMMAND} <words from its title> [artboard].` : 'No Design canvases found for your account.' }
      const match = query.length ? bestMatch(canvases.map(c => ({ key: c.title, value: c })), query) : null
      if (match && match.unique) {
        if (!canvas || canvas.url !== match.value.url) canvas = { url: match.value.url, root: '' }
        query.splice(0, query.length, ...match.rest)
      } else if (!canvas || !canvas.url) {
        if (!canvases.length) return { text: `No Design canvas is known yet and none was found for your account. Run /${COMMAND} <canvas url> [Board.dc.html].` }
        const shown = match && match.candidates.length ? match.candidates : canvases
        return { text: `Which canvas? Say /${COMMAND} <words from its title> [artboard]:\n${shown.map(c => `  ${c.title}`).join('\n')}` }
      }
    }
    const ready = await ensureRoot($, canvas)
    if ('text' in ready) return ready
    canvas = ready.canvas
    if (wantList) return listBoards($, canvas)
    let select: string | undefined
    if (!board) {
      const ctx = await viewContext($)
      if (ctx.board) { board = ctx.board; select = ctx.select }
    }
    if (!board) {
      const names = await boardNames($, canvas)
      if (query.length) {
        const titles = await boardTitles($, canvas)
        const m = bestMatch(names.map(n => ({ key: n.replace(/\.dc\.html$/, '') + ' ' + (titles[n] || ''), value: n })), query)
        if (m && m.unique) board = m.value
        else if (m && m.candidates.length) return { text: `Which artboard? ${m.candidates.map(c => c.trim()).join(' · ')}` }
      }
      if (!board && names.length === 1) board = names[0]
      if (!board) return { text: names.length ? `Which artboard? /${COMMAND} <name>  (or /${COMMAND} --list to see which have editable shapes)\n${names.map(n => `  ${n.replace(/\.dc\.html$/, '')}`).join('\n')}` : `No artboards found for ${canvas.url}.` }
    }
    return openEditor($, canvas, board, select)
  })

  // A comment sent to Claude from the canvas that asks to edit shapes opens the editor on its anchor.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !/Artifact comment sent to Claude/.test(e.text)) return next(e)
    const body = (e.text.match(/=== BEGIN ARTIFACT COMMENT \w+ ===\n([\s\S]*?)\n=== END ARTIFACT COMMENT/) || [])[1] || ''
    if (!TRIGGER.test(body)) return next(e)
    const uuid = (e.text.match(/Artifact: https?:\/\/\S+\/artifact\/([0-9a-f-]{36})/) || [])[1]
    const anchor = e.text.match(/Anchor detail: (\S+\.dc\.html): #(\d+:\d+(?:\/\d+)*)/)
    const board = anchor ? decodeURIComponent(anchor[1]) : undefined
    const select = anchor ? anchor[2] : undefined
    let canvas = await read($, canvasRef)
    if (!canvas || (uuid && canvas.uuid && canvas.uuid !== uuid)) return next({ ...e, text: e.text + `\n\n[${PLUGIN}] The comment asks to edit shapes, but this session's vector editor is bound to a different canvas (${canvas ? canvas.url : 'none yet'}). Reply in the thread that the user should run /${COMMAND} <that canvas url> ${board ?? ''} in the chat.` })
    const ready = await ensureRoot($, canvas)
    if ('text' in ready) return next({ ...e, text: e.text + `\n\n[${PLUGIN}] ${ready.text}` })
    canvas = ready.canvas
    const target = board && isBoardName(board) ? board : (await boardNames($, canvas))[0]
    if (!target) return next(e)
    const opened = await openEditor($, canvas, target, select)
    const note = [opened.text, ...(opened.context ?? [])].join(' ')
    return next({ ...e, text: e.text + `\n\n[${PLUGIN}] ${note} Then reply in the comment thread, in one line, that the vector editor is open on ${target} in the browser pane beside the canvas.` })
  })
}

/** Make sure the canvas has a root the Artifact tool accepts (the folder its own `read` saves into). */
async function ensureRoot($: $, canvas: ArtboardVectorCanvas): Promise<{ canvas: ArtboardVectorCanvas } | { text: string }> {
  let next = canvas
  if (!canvas.root || canvas.root.startsWith($.plugin.root) || !(await $.fs.exists(canvas.root))) {
    const probe = await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url, path: 'project/canvas.json' })
    const saved = (probe.text || '').match(/saved(?: under)?:? "([^"]+)"/)
    const folder = saved ? saved[1].replace(/\/project\/canvas\.json$/, '') : null
    if (!folder || !(await $.fs.exists(folder))) return { text: `Could not find a folder to work in for ${canvas.url}: ${(probe.text || probe.deny || '').toString().slice(0, 300)}` }
    const uuid = ((probe.text || '').match(/Artifact ([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1]
    next = { url: canvas.url, root: folder, uuid: uuid ?? canvas.uuid }
  }
  await update($, canvasRef, () => next)
  try { await $.store.set('canvas', next) } catch {}
  return { canvas: next }
}

/** The canvas's artboard names, from the local index or the canvas's own. */
async function boardNames($: $, canvas: ArtboardVectorCanvas): Promise<string[]> {
  let names: string[] = []
  try { names = (JSON.parse(await $.fs.read(`${canvas.root}/project/canvas.json`)).order || []).filter(isBoardName) } catch {}
  if (names.length) return names
  const idx = await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url, path: 'project/canvas.json', out_dir: canvas.root })
  if (idx.deny === undefined && idx.isError !== true) {
    try { names = (JSON.parse(await $.fs.read(`${canvas.root}/project/canvas.json`)).order || []).filter(isBoardName) } catch {}
  }
  if (!names.length) try { names = (await $.fs.list(`${canvas.root}/project`)).map(f => f.name).filter(isBoardName) } catch {}
  return names
}

/** `/vector-edit --list`: every artboard with how many editable shapes it holds. */
async function listBoards($: $, canvas: ArtboardVectorCanvas): Promise<{ text: string }> {
  const names = await boardNames($, canvas)
  if (!names.length) return { text: `No artboards found for ${canvas.url}.` }
  const missing: string[] = []
  for (const n of names) if (!(await $.fs.exists(`${canvas.root}/project/${n}`))) missing.push(n)
  if (missing.length) await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url, paths: missing.map(n => `project/${n}`), out_dir: canvas.root })
  const rows: string[] = []
  for (const n of names) {
    try {
      const c = countEditable(await $.fs.read(`${canvas.root}/project/${n}`))
      rows.push(`  ${c.shapes ? String(c.shapes).padStart(3) : '  -'}  ${n}${c.locked ? `  (${c.locked} locked)` : ''}${c.svgs === 0 ? '  no inline svg' : ''}`)
    } catch { rows.push(`    ?  ${n}  (not readable)`) }
  }
  return { text: `Editable shapes per artboard on ${canvas.url}:\n${rows.join('\n')}\n\nOpen one with /${COMMAND} <name>.` }
}

/** Pull the board fresh, make sure the server runs for this root, and open the editor. */
async function openEditor($: $, canvas: ArtboardVectorCanvas, board: string, select?: string): Promise<{ text: string; context?: string[] }> {
  const pulled = await $.tool.call({ tool: 'Artifact', action: 'read', url: canvas.url, path: `project/${board}`, out_dir: canvas.root })
  const localPath = `${canvas.root}/project/${board}`
  if (!(await $.fs.exists(localPath))) {
    const saved = (pulled.text || '').match(/saved(?: under)?:? "([^"]+)"/)
    if (saved && (await $.fs.exists(saved[1]))) {
      const src = saved[1].endsWith(board) ? saved[1] : `${saved[1]}/project/${board}`
      if (await $.fs.exists(src)) await $.fs.write(localPath, await $.fs.read(src))
    }
  }
  if (!(await $.fs.exists(localPath))) return { text: `Could not get project/${board} from ${canvas.url}: ${(pulled.text || pulled.deny || '').toString().slice(0, 300)}` }

  let server = await read($, serverRef)
  if (!(await serverAlive($, server, canvas.root))) {
    await stopServer($, server)
    try { server = await startServer($, canvas.root) } catch (err) {
      return { text: `The vector editor server could not start: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const url = `http://127.0.0.1:${server!.port}/edit?t=${server!.token}&board=${encodeURIComponent(board)}${select ? `&select=${encodeURIComponent(select)}` : ''}`

  let opened = false
  for (const name of ['Claude_Browser', 'Claude Browser', 'claude_browser']) {
    try {
      const r = await $.mcp.call(name, 'preview_start', { url })
      if (!r.isError) { opened = true; break }
    } catch {}
  }
  $.ui.status(`vector: editing ${board}`)
  return opened
    ? { text: `Vector editor open for ${board}.` }
    : { text: `Vector editor ready for ${board}: ${url}`, context: [`Open ${url} in the built-in browser pane with preview_start (url), then stop and let the user edit there. The ${PLUGIN} mod republishes the canvas itself on save; do not read, verify or publish the board unless asked.`] }
}

/** The user's Design canvases, from the Artifact tool's listing. */
async function listCanvases($: $): Promise<{ title: string; url: string }[]> {
  const ran = await $.tool.call({ tool: 'Artifact', action: 'list', type: 'Design', limit: 50 })
  if (ran.deny !== undefined || ran.isError === true || !ran.text) return []
  const out: { title: string; url: string }[] = []
  for (const line of ran.text.split('\n')) {
    const m = line.match(/^- (?:\([^)]*\) )?(?:[^:]*default[^:]*: )?(.+?) — (https:\/\/claude\.ai\/artifact\/[A-Za-z0-9-]+)/)
    if (m) out.push({ title: m[1].trim(), url: m[2] })
  }
  return out
}

/** Words against names: every query word must appear (case-insensitive) in the name; unique when exactly one name wins. */
function bestMatch<T>(items: { key: string; value: T }[], words: string[]): { unique: boolean; value: T; candidates: string[]; rest: string[] } | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  let best: { score: number; items: { key: string; value: T }[]; rest: string[] } | null = null
  // try the longest prefix of the words first, so trailing words can name the artboard
  for (let n = words.length; n >= 1; n--) {
    const use = words.slice(0, n).map(norm), rest = words.slice(n)
    const hits = items.filter(it => { const k = ' ' + norm(it.key) + ' '; return use.every(w => k.includes(w)) })
    if (hits.length) { best = { score: n, items: hits, rest }; break }
  }
  if (!best) return null
  return { unique: best.items.length === 1, value: best.items[0].value, candidates: best.items.map(i => i.key), rest: best.rest }
}

/** Artboard titles from the local canvas.json, keyed by file name. */
async function boardTitles($: $, canvas: ArtboardVectorCanvas): Promise<Record<string, string>> {
  try {
    const idx = JSON.parse(await $.fs.read(`${canvas.root}/project/canvas.json`))
    const out: Record<string, string> = {}
    for (const [name, b] of Object.entries(idx.boards || {})) if (b && typeof (b as { title?: unknown }).title === 'string') out[name] = (b as { title: string }).title
    return out
  } catch { return {} }
}
