// Recursive split-tree renderer with pointer and keyboard resizable dividers.
import { Fragment, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { resizeAt } from '../../../shared/layout';
import type { LayoutNode, PaneLeaf, SplitNode } from '../../../shared/types';

interface Props {
  node: LayoutNode;
  renderPane(pane: PaneLeaf): ReactNode;
  onResize(splitId: string, sizes: number[]): void;
}

export function SplitView({ node, renderPane, onResize }: Props) {
  if (node.type === 'pane') return <>{renderPane(node)}</>;
  return (
    <div className={`split split--${node.direction}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <Divider split={node} index={i - 1} onResize={onResize} />}
          <div className="split__cell" style={{ flex: `${node.sizes[i] ?? 1} 1 0px` }}>
            <SplitView node={child} renderPane={renderPane} onResize={onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

function Divider({ split, index, onResize }: { split: SplitNode; index: number; onResize: Props['onResize'] }) {
  const drag = useRef<{ start: number; total: number; sizes: number[]; frame: number; latest: number } | null>(null);
  const horizontal = split.direction === 'row';
  const before = split.sizes[index] ?? 0;
  const after = split.sizes[index + 1] ?? 0;
  const pairPercent = before + after > 0 ? Math.round((before / (before + after)) * 100) : 50;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      start: horizontal ? event.clientX : event.clientY,
      total: Math.max(1, horizontal ? rect.width : rect.height),
      sizes: split.sizes,
      frame: 0,
      latest: horizontal ? event.clientX : event.clientY,
    };
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.latest = horizontal ? event.clientX : event.clientY;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      onResize(split.id, resizeAt(d.sizes, index, (d.latest - d.start) / d.total));
    });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    onResize(split.id, resizeAt(d.sizes, index, (d.latest - d.start) / d.total));
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
    let delta = 0;
    if (event.key === decrease) delta = -step;
    else if (event.key === increase) delta = step;
    else if (event.key === 'Home') delta = -1;
    else if (event.key === 'End') delta = 1;
    else return;
    event.preventDefault();
    onResize(split.id, resizeAt(split.sizes, index, delta));
  };

  return (
    <div
      className={`divider divider--${horizontal ? 'vertical' : 'horizontal'}`}
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pairPercent}
      aria-label={horizontal ? 'Resize panes horizontally' : 'Resize panes vertically'}
      title="Drag to resize. Arrow keys also work when focused."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
