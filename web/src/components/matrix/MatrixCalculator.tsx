import { useCallback, useMemo, useReducer, useState } from 'react';
import type { MatrixDraft, OpResponse, SlotBank, SlotValue } from './types';
import { atomToSlotValue, emptyDraft, resolveMatrix, stampDraftIntoDraft } from './resolve';
import { getOp, type OperationKind } from './operations';
import type { DraftSource } from './drag';
import MatrixEditor from './MatrixEditor';
import OperationSelector from './OperationSelector';
import ResultPanel from './ResultPanel';
import SlotBankView from './SlotBank';
import TracePanel from './TracePanel';
import { useMatrixWasm } from './useMatrixWasm';

type State = {
  n: number;
  a: MatrixDraft;
  b: MatrixDraft;
  k: number;
  p: number;
  rowSel: string;
  colSel: string;
  operation: OperationKind;
  slots: SlotBank;
  response: OpResponse | null;
  error: string | null;
};

type Action =
  | { type: 'setN'; value: number }
  | { type: 'setA'; draft: MatrixDraft }
  | { type: 'setB'; draft: MatrixDraft }
  | { type: 'setK'; value: number }
  | { type: 'setP'; value: number }
  | { type: 'setRowSel'; value: string }
  | { type: 'setColSel'; value: string }
  | { type: 'setOperation'; value: OperationKind }
  | { type: 'setResponse'; value: OpResponse }
  | { type: 'setError'; value: string | null }
  | { type: 'setSlot'; index: number; value: SlotValue }
  | { type: 'clearSlot'; index: number }
  | { type: 'swapAB' }
  | { type: 'reset' };

const initialSlots: SlotBank = Array.from({ length: 10 }, () => ({ kind: 'empty' as const }));

function initialState(): State {
  return {
    n: 26,
    a: emptyDraft(2, 2),
    b: emptyDraft(2, 2),
    k: 1,
    p: 2,
    rowSel: '0',
    colSel: '0',
    operation: 'mul',
    slots: initialSlots,
    response: null,
    error: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'setN':
      return { ...state, n: action.value, response: null, error: null };
    case 'setA':
      return { ...state, a: action.draft };
    case 'setB':
      return { ...state, b: action.draft };
    case 'setK':
      return { ...state, k: action.value };
    case 'setP':
      return { ...state, p: action.value };
    case 'setRowSel':
      return { ...state, rowSel: action.value };
    case 'setColSel':
      return { ...state, colSel: action.value };
    case 'setOperation':
      return { ...state, operation: action.value };
    case 'setResponse':
      return { ...state, response: action.value, error: null };
    case 'setError':
      return { ...state, response: null, error: action.value };
    case 'setSlot': {
      const slots = state.slots.slice();
      slots[action.index] = action.value;
      return { ...state, slots };
    }
    case 'clearSlot': {
      const slots = state.slots.slice();
      slots[action.index] = { kind: 'empty' };
      return { ...state, slots };
    }
    case 'swapAB':
      return { ...state, a: state.b, b: state.a };
    case 'reset':
      return { ...initialState(), n: state.n };
    default:
      return state;
  }
}

function parseIdxList(input: string, max: number): number[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 0 || n >= max) {
        throw new Error(`index "${t}" out of range (valid: 0..${max - 1})`);
      }
      return n;
    });
}

export default function MatrixCalculator() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [inspecting, setInspecting] = useState<number | null>(null);
  const wasm = useMatrixWasm();
  const op = useMemo(() => getOp(state.operation), [state.operation]);
  const savableResult = useMemo(
    () => (state.response ? atomToSlotValue(state.response.result) : null),
    [state.response],
  );
  const handleSaveResult = useCallback(
    (index: number) => {
      if (savableResult) dispatch({ type: 'setSlot', index, value: savableResult });
    },
    [savableResult],
  );

  const handleDraftCrossDrop = useCallback(
    (target: DraftSource, from: DraftSource, row: number, col: number) => {
      if (from === target) return;
      const src = from === 'A' ? state.a : state.b;
      const dst = target === 'A' ? state.a : state.b;
      const next = stampDraftIntoDraft(dst, src, row, col);
      dispatch({ type: target === 'A' ? 'setA' : 'setB', draft: next });
    },
    [state.a, state.b],
  );

  const handleSaveDraft = useCallback(
    (index: number, source: DraftSource) => {
      const draft = source === 'A' ? state.a : state.b;
      try {
        const resolved = resolveMatrix(draft, state.slots);
        dispatch({
          type: 'setSlot',
          index,
          value: {
            kind: 'matrix',
            rows: resolved.rows,
            cols: resolved.cols,
            data: resolved.data,
          },
        });
      } catch (e) {
        dispatch({
          type: 'setError',
          value: `Cannot save matrix ${source} to S${index}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    },
    [state.a, state.b, state.slots],
  );

  function run() {
    if (wasm.status !== 'ready') {
      dispatch({ type: 'setError', value: 'WASM not loaded yet' });
      return;
    }
    if (state.n < 2) {
      dispatch({ type: 'setError', value: 'Modulus must be ≥ 2' });
      return;
    }
    try {
      const req: Record<string, unknown> = { kind: state.operation, n: state.n };
      req.a = resolveMatrix(state.a, state.slots);
      if (op.needsB) {
        const b = resolveMatrix(state.b, state.slots);
        if (op.bIsVector && b.cols !== 1) {
          throw new Error(`${op.label}: B must be a column vector (${b.rows}×1)`);
        }
        req.b = b;
      }
      if (op.needsK) req.k = state.k;
      if (op.needsP) req.p = state.p;
      if (op.needsSel) {
        req.row_sel = parseIdxList(state.rowSel, state.a.rows);
        req.col_sel = parseIdxList(state.colSel, state.a.cols);
      }
      if (op.requiresSquareA && state.a.rows !== state.a.cols) {
        throw new Error(`${op.label} requires square A (got ${state.a.rows}×${state.a.cols})`);
      }
      const resp = wasm.call(req);
      dispatch({ type: 'setResponse', value: resp });
    } catch (e) {
      dispatch({ type: 'setError', value: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Top bar */}
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[0.75rem] text-[#a0a0aa] uppercase tracking-[0.08em]">
            Modulus N
          </span>
          <input
            type="number"
            min={2}
            value={state.n}
            onChange={(e) => dispatch({ type: 'setN', value: parseInt(e.target.value, 10) || 2 })}
            className="w-28 bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.95rem] text-text-primary text-center focus:outline-none focus:border-accent transition-colors duration-200"
          />
        </label>
        <button
          type="button"
          onClick={() => dispatch({ type: 'reset' })}
          className="font-mono text-[0.72rem] uppercase tracking-[0.1em] text-text-secondary hover:text-accent transition-colors"
        >
          Reset workspace
        </button>
      </div>

      {/* Operands + operation */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto] max-md:grid-cols-1 gap-6 items-start">
        <MatrixEditor
          id="A"
          label="Matrix A"
          value={state.a}
          onChange={(draft) => dispatch({ type: 'setA', draft })}
          onDraftDrop={(from, r, c) => handleDraftCrossDrop('A', from, r, c)}
          slots={state.slots}
        />
        <div className="flex items-center justify-center max-md:justify-start">
          <button
            type="button"
            onClick={() => dispatch({ type: 'swapAB' })}
            disabled={!op.needsB}
            title="Swap A ↔ B (operations are not commutative)"
            className="font-mono text-[0.75rem] uppercase tracking-[0.1em] text-text-secondary hover:text-accent disabled:opacity-20 disabled:cursor-not-allowed border border-[#3a3a42] hover:border-accent px-3 py-2 transition-colors max-md:self-center"
            aria-label="swap A and B"
          >
            A ↔ B
          </button>
        </div>
        {op.needsB ? (
          <MatrixEditor
            id="B"
            label={op.bIsVector ? 'Vector b' : 'Matrix B'}
            value={state.b}
            onChange={(draft) => dispatch({ type: 'setB', draft })}
            onDraftDrop={(from, r, c) => handleDraftCrossDrop('B', from, r, c)}
            slots={state.slots}
            lockCols={op.bIsVector ? 1 : undefined}
          />
        ) : (
          <div className="opacity-30 pointer-events-none select-none">
            <MatrixEditor
              id="B"
              label="—"
              value={state.b}
              onChange={() => {}}
              slots={state.slots}
            />
          </div>
        )}
        <div className="flex flex-col gap-3 min-w-[14rem]">
          <OperationSelector
            value={state.operation}
            onChange={(k) => dispatch({ type: 'setOperation', value: k })}
          />

          {op.needsK && (
            <ExtraInput
              label="scalar k"
              value={state.k}
              onChange={(v) => dispatch({ type: 'setK', value: v })}
            />
          )}
          {op.needsP && (
            <ExtraInput
              label="power p"
              value={state.p}
              min={0}
              onChange={(v) => dispatch({ type: 'setP', value: v })}
            />
          )}
          {op.needsSel && (
            <>
              <TextInput
                label="row indices (0-based, comma-separated)"
                value={state.rowSel}
                onChange={(v) => dispatch({ type: 'setRowSel', value: v })}
              />
              <TextInput
                label="col indices"
                value={state.colSel}
                onChange={(v) => dispatch({ type: 'setColSel', value: v })}
              />
            </>
          )}

          <button
            type="button"
            onClick={run}
            disabled={wasm.status !== 'ready'}
            className="mt-1 font-mono text-[0.8rem] font-semibold tracking-[0.1em] uppercase py-3 px-6 bg-accent-deep text-white border-none cursor-pointer transition-all duration-200 hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {wasm.status === 'loading' ? 'Loading…' : 'Compute'}
          </button>
          {wasm.status === 'error' && (
            <span className="font-mono text-[0.72rem] text-red-400">{wasm.error}</span>
          )}
        </div>
      </div>

      {/* Error + result */}
      {state.error && (
        <div className="p-4 border border-red-500/50 bg-red-500/10">
          <span className="font-mono text-[0.85rem] text-red-400">{state.error}</span>
        </div>
      )}
      <ResultPanel
        response={state.response}
        onSave={(index, value) => dispatch({ type: 'setSlot', index, value })}
      />
      {state.response && state.response.trace.length > 0 && (
        <TracePanel steps={state.response.trace} n={state.response.n} />
      )}

      {/* Slots */}
      <SlotBankView
        slots={state.slots}
        onClear={(i) => dispatch({ type: 'clearSlot', index: i })}
        onInspect={(i) => setInspecting(i)}
        hasResult={savableResult !== null}
        onSaveResult={handleSaveResult}
        onSaveDraft={handleSaveDraft}
      />
      {inspecting !== null && (
        <SlotInspector
          index={inspecting}
          value={state.slots[inspecting]}
          onClose={() => setInspecting(null)}
        />
      )}
    </div>
  );
}

function ExtraInput({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[0.7rem] text-text-secondary uppercase tracking-wider">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="bg-[#0c0c12] border border-[#3a3a42] p-2 font-mono text-[0.9rem] text-text-primary text-center focus:outline-none focus:border-accent transition-colors duration-200"
      />
    </label>
  );
}

function TextInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[0.7rem] text-text-secondary uppercase tracking-wider">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[#0c0c12] border border-[#3a3a42] p-2 font-mono text-[0.85rem] text-text-primary focus:outline-none focus:border-accent transition-colors duration-200"
      />
    </label>
  );
}

function SlotInspector({
  index,
  value,
  onClose,
}: {
  index: number;
  value: SlotValue;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-[#3a3a42] p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-[0.85rem] font-semibold text-accent">
            Slot S{index}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[0.85rem] text-text-secondary hover:text-text-primary"
          >
            ×
          </button>
        </div>
        {value.kind === 'empty' && (
          <span className="font-mono text-[0.85rem] text-text-secondary">empty slot</span>
        )}
        {value.kind === 'scalar' && (
          <div className="font-mono text-[1.1rem]">
            scalar = <span className="text-accent">{value.value}</span>
          </div>
        )}
        {value.kind === 'matrix' && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[0.75rem] text-text-secondary">
              matrix {value.rows}×{value.cols}
            </span>
            <div className="overflow-auto">
              <table className="font-mono text-[0.85rem]">
                <tbody>
                  {value.data.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td
                          key={j}
                          className="px-2 py-1 text-right tabular-nums border border-[#3a3a42]/50"
                        >
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
