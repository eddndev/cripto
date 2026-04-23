import type { Atom, MatrixDraft, SlotBank, SlotValue } from './types';

export type ResolvedMatrix = { rows: number; cols: number; data: number[][] };

/**
 * Resolve a user-entered cell token against the slot bank.
 * Accepted forms:
 *   - integer literal: "3", "-7", "0"
 *   - scalar slot:     "S4"
 *   - matrix element:  "S2[1,0]"
 */
function resolveCell(token: string, slots: SlotBank, rowIdx: number, colIdx: number): number {
  const t = token.trim();
  if (t === '') throw new Error(`cell (${rowIdx + 1}, ${colIdx + 1}) is empty`);

  const literal = /^-?\d+$/;
  if (literal.test(t)) return parseInt(t, 10);

  const scalarRef = /^S(\d)$/i;
  const elementRef = /^S(\d)\[(\d+),\s*(\d+)\]$/i;

  const sm = t.match(scalarRef);
  if (sm) {
    const idx = parseInt(sm[1], 10);
    const slot = slots[idx];
    if (!slot || slot.kind === 'empty') {
      throw new Error(`cell (${rowIdx + 1}, ${colIdx + 1}) references empty slot S${idx}`);
    }
    if (slot.kind !== 'scalar') {
      throw new Error(
        `cell (${rowIdx + 1}, ${colIdx + 1}): S${idx} is a matrix — use S${idx}[i,j]`,
      );
    }
    return slot.value;
  }

  const em = t.match(elementRef);
  if (em) {
    const idx = parseInt(em[1], 10);
    const i = parseInt(em[2], 10);
    const j = parseInt(em[3], 10);
    const slot = slots[idx];
    if (!slot || slot.kind === 'empty') {
      throw new Error(`cell (${rowIdx + 1}, ${colIdx + 1}) references empty slot S${idx}`);
    }
    if (slot.kind !== 'matrix') {
      throw new Error(`cell (${rowIdx + 1}, ${colIdx + 1}): S${idx} is a scalar — use S${idx}`);
    }
    if (i < 0 || i >= slot.rows || j < 0 || j >= slot.cols) {
      throw new Error(
        `cell (${rowIdx + 1}, ${colIdx + 1}): S${idx}[${i},${j}] out of range (${slot.rows}×${slot.cols})`,
      );
    }
    return slot.data[i][j];
  }

  throw new Error(
    `cell (${rowIdx + 1}, ${colIdx + 1}): "${t}" is not a literal, Sk, or Sk[i,j]`,
  );
}

export function resolveMatrix(draft: MatrixDraft, slots: SlotBank): ResolvedMatrix {
  const data: number[][] = [];
  for (let i = 0; i < draft.rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < draft.cols; j++) {
      row.push(resolveCell(draft.cells[i][j] ?? '', slots, i, j));
    }
    data.push(row);
  }
  return { rows: draft.rows, cols: draft.cols, data };
}

export function emptyDraft(rows: number, cols: number): MatrixDraft {
  return {
    rows,
    cols,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '0')),
  };
}

export function resizeDraft(draft: MatrixDraft, rows: number, cols: number): MatrixDraft {
  const cells: string[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: string[] = [];
    for (let j = 0; j < cols; j++) {
      row.push(draft.cells[i]?.[j] ?? '0');
    }
    cells.push(row);
  }
  return { rows, cols, cells };
}

export function modReduce(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/** Convert an operation result atom into a persistable slot value. Returns null for
 * atoms that cannot be saved (e.g., `system`). */
export function atomToSlotValue(atom: Atom): SlotValue | null {
  if (atom.type === 'scalar') return { kind: 'scalar', value: atom.value };
  if (atom.type === 'matrix')
    return { kind: 'matrix', rows: atom.rows, cols: atom.cols, data: atom.data };
  if (atom.type === 'rref')
    return { kind: 'matrix', rows: atom.rows, cols: atom.cols, data: atom.data };
  return null;
}

/** Maximum dimension enforced by the matrix editor. Keep in sync with MatrixEditor. */
export const MAX_DIM = 6;

/**
 * Build a new draft by stamping `src` cells into `dst` with the given
 * (anchorRow, anchorCol) as top-left. Cell strings are copied verbatim, so any
 * `Sk` / `Sk[i,j]` references inside `src` are preserved. The destination is
 * auto-resized up to MAX_DIM; overflow is clamped.
 */
export function stampDraftIntoDraft(
  dst: MatrixDraft,
  src: MatrixDraft,
  anchorRow: number,
  anchorCol: number,
): MatrixDraft {
  const targetRows = Math.min(MAX_DIM, Math.max(dst.rows, anchorRow + src.rows));
  const targetCols = Math.min(MAX_DIM, Math.max(dst.cols, anchorCol + src.cols));
  const resized = resizeDraft(dst, targetRows, targetCols);
  const cells = resized.cells.map((row) => row.slice());
  for (let i = 0; i < src.rows; i++) {
    for (let j = 0; j < src.cols; j++) {
      const r = anchorRow + i;
      const c = anchorCol + j;
      if (r >= targetRows || c >= targetCols) continue;
      cells[r][c] = src.cells[i][j] ?? '0';
    }
  }
  return { rows: targetRows, cols: targetCols, cells };
}

/**
 * Build a new draft by stamping a slot's contents into `draft` with the given
 * (anchorRow, anchorCol) as top-left. Stored references keep the link to the slot:
 *   - scalar slot → `Sk`
 *   - matrix slot → `Sk[i,j]`
 * The draft is auto-resized up to MAX_DIM; overflow is clamped (cells outside the
 * clamped region are silently dropped).
 */
export function stampSlotIntoDraft(
  draft: MatrixDraft,
  slotIdx: number,
  slot: SlotValue,
  anchorRow: number,
  anchorCol: number,
): MatrixDraft {
  if (slot.kind === 'empty') return draft;

  const payloadRows = slot.kind === 'scalar' ? 1 : slot.rows;
  const payloadCols = slot.kind === 'scalar' ? 1 : slot.cols;

  const targetRows = Math.min(MAX_DIM, Math.max(draft.rows, anchorRow + payloadRows));
  const targetCols = Math.min(MAX_DIM, Math.max(draft.cols, anchorCol + payloadCols));

  const resized = resizeDraft(draft, targetRows, targetCols);
  const cells = resized.cells.map((row) => row.slice());

  for (let i = 0; i < payloadRows; i++) {
    for (let j = 0; j < payloadCols; j++) {
      const r = anchorRow + i;
      const c = anchorCol + j;
      if (r >= targetRows || c >= targetCols) continue;
      cells[r][c] = slot.kind === 'scalar' ? `S${slotIdx}` : `S${slotIdx}[${i},${j}]`;
    }
  }
  return { rows: targetRows, cols: targetCols, cells };
}

