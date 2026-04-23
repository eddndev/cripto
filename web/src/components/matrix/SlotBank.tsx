import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { SlotBank, SlotValue } from './types';
import { getDraftDrag, isDraftDrag, isResultDrag, setSlotDrag, type DraftSource } from './drag';

type Props = {
  slots: SlotBank;
  onClear: (index: number) => void;
  onInspect?: (index: number) => void;
  /** True when there is a current result the user can drop here. */
  hasResult: boolean;
  /** Invoked when the user drops the current result onto slot `index`. */
  onSaveResult: (index: number) => void;
  /** Invoked when the user drops matrix A or B onto slot `index`. */
  onSaveDraft: (index: number, source: DraftSource) => void;
};

export default function SlotBankView({
  slots,
  onClear,
  onInspect,
  hasResult,
  onSaveResult,
  onSaveDraft,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[0.75rem] text-[#a0a0aa] uppercase tracking-[0.08em]">
          Slots
        </span>
        <span className="font-mono text-[0.7rem] text-text-secondary/70">
          drag a tile into a matrix cell · drop a matrix or the result here to save
        </span>
      </div>
      <div className="grid grid-cols-5 max-md:grid-cols-2 gap-2">
        {slots.map((s, i) => (
          <SlotTile
            key={i}
            index={i}
            value={s}
            onClear={() => onClear(i)}
            onInspect={onInspect ? () => onInspect(i) : undefined}
            hasResult={hasResult}
            onSaveResult={() => onSaveResult(i)}
            onSaveDraft={(source) => onSaveDraft(i, source)}
          />
        ))}
      </div>
    </div>
  );
}

function SlotTile({
  index,
  value,
  onClear,
  onInspect,
  hasResult,
  onSaveResult,
  onSaveDraft,
}: {
  index: number;
  value: SlotValue;
  onClear: () => void;
  onInspect?: () => void;
  hasResult: boolean;
  onSaveResult: () => void;
  onSaveDraft: (source: DraftSource) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const isEmpty = value.kind === 'empty';
  const isSquare = value.kind === 'matrix' && value.rows === value.cols;
  const draggable = !isEmpty;

  function handleDragStart(ev: ReactDragEvent) {
    if (isEmpty) {
      ev.preventDefault();
      return;
    }
    setSlotDrag(ev, index);
  }

  function handleDragOver(ev: ReactDragEvent) {
    const acceptsResult = hasResult && isResultDrag(ev);
    const acceptsDraft = isDraftDrag(ev);
    if (!acceptsResult && !acceptsDraft) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    setAccepting(true);
  }

  function handleDrop(ev: ReactDragEvent) {
    if (hasResult && isResultDrag(ev)) {
      ev.preventDefault();
      setAccepting(false);
      onSaveResult();
      return;
    }
    if (isDraftDrag(ev)) {
      const src = getDraftDrag(ev);
      if (!src) return;
      ev.preventDefault();
      setAccepting(false);
      onSaveDraft(src);
      return;
    }
  }

  const hint = isEmpty
    ? hasResult
      ? 'drop result / A / B here'
      : 'drop A or B here'
    : null;

  function handleTileClick() {
    if (!isEmpty && onInspect) onInspect();
  }

  function handleTileKey(ev: React.KeyboardEvent) {
    if (isEmpty || !onInspect) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onInspect();
    }
  }

  return (
    <div
      draggable={draggable}
      role={!isEmpty ? 'button' : undefined}
      tabIndex={!isEmpty ? 0 : undefined}
      aria-label={!isEmpty ? `inspect slot S${index}` : undefined}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={() => setAccepting(false)}
      onDrop={handleDrop}
      onClick={handleTileClick}
      onKeyDown={handleTileKey}
      className={`group relative p-2.5 border transition-colors duration-200 select-none ${
        isEmpty
          ? 'border-dashed border-[#3a3a42]/60'
          : `border-[#3a3a42] bg-[#0c0c12] cursor-grab active:cursor-grabbing hover:border-accent focus:outline-none focus:border-accent`
      } ${accepting ? 'ring-2 ring-accent bg-accent/5' : ''}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[0.75rem] font-semibold text-accent">S{index}</span>
        {!isEmpty && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="opacity-0 group-hover:opacity-100 font-mono text-[0.65rem] text-text-secondary hover:text-red-400 transition-opacity"
            aria-label={`clear S${index}`}
          >
            ×
          </button>
        )}
      </div>
      {hint && <span className="font-mono text-[0.7rem] text-text-secondary/40">{hint}</span>}
      {value.kind === 'scalar' && (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[0.7rem] text-text-secondary">scalar</span>
          <span className="font-mono text-[0.95rem] text-text-primary tabular-nums">
            {value.value}
          </span>
        </div>
      )}
      {value.kind === 'matrix' && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.7rem] text-text-secondary">
            {value.rows}×{value.cols}
          </span>
          {isSquare && (
            <span
              className="font-mono text-[0.65rem] text-accent-deep border border-accent-deep/60 px-1"
              title="square"
            >
              □
            </span>
          )}
        </div>
      )}
      {draggable && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 right-1.5 font-mono text-[0.6rem] text-text-secondary/40 group-hover:text-accent/70 transition-colors"
        >
          ⋮⋮
        </span>
      )}
    </div>
  );
}
