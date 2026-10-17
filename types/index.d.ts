/** The /design canvas the editor works on: its artifact url and the local root holding `project/`. */
export type ArtboardVectorCanvas = { url: string; root: string; uuid?: string }
/** The running editor server. */
export type ArtboardVectorServer = { port: number; token: string; root: string }
/** Per-board editor state, keyed by the board's file name (`Shapes.dc.html`). */
export type ArtboardVectorBoard = { dirty: boolean; lastSaved: string | null }
/** A save the mod could not publish itself; Claude is asked to publish it on the next turn. */
export type ArtboardVectorPending = { url: string; root: string; filePath: string; board: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    'artboard-vector': {
      canvas: ArtboardVectorCanvas | null
      server: ArtboardVectorServer | null
      boards: { readonly byId: ArtboardVectorBoard }
      pendingPublish: ArtboardVectorPending | null
      notes: string[]
    }
  }
}
