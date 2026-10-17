export type SvgSpan = { ordinal: number; start: number; end: number; text: string; hash: string }
export function hashText(text: string): string
export function findFragment(text: string): { start: number; end: number } | null
export function scanSvgSpans(text: string): SvgSpan[]
export function parseTree(spanText: string): unknown
export function nodeAtPath(tree: unknown, path: number[]): unknown
export function attrOf(node: unknown, name: string): unknown
export function applyEdits(text: string, edits: unknown[]): { text: string; changed: number[] }
export function readDataProps(text: string): Record<string, unknown>
export function countEditable(text: string): { svgs: number; shapes: number; locked: number }
