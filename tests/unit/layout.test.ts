import { describe, expect, it } from 'vitest';
import {
  computeRects,
  createPane,
  listPanes,
  neighborPane,
  normalizeSizes,
  removePane,
  resizeAt,
  setSplitSizes,
  splitPane,
} from '../../src/shared/layout';
import type { LayoutNode } from '../../src/shared/types';
import { validateLayout } from '../../src/shared/validation';

const ids = (node: LayoutNode | null) => listPanes(node).map((p) => p.id);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('split tree', () => {
  it('splits a single pane into a two-child split', () => {
    const root = splitPane(createPane('a', 'pwsh'), 'a', 'row', createPane('b', 'pwsh'), 's1');
    expect(root).toMatchObject({ type: 'split', direction: 'row', sizes: [0.5, 0.5] });
    expect(ids(root)).toEqual(['a', 'b']);
  });

  it('adds a sibling when splitting in the same direction instead of nesting', () => {
    let root = splitPane(createPane('a', 'pwsh'), 'a', 'row', createPane('b', 'pwsh'), 's1');
    root = splitPane(root, 'a', 'row', createPane('c', 'pwsh'), 's2');
    expect(root.type === 'split' && root.children.length).toBe(3);
    expect(ids(root)).toEqual(['a', 'c', 'b']);
    expect(root.type === 'split' && root.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('nests when splitting in the other direction', () => {
    let root = splitPane(createPane('a', 'pwsh'), 'a', 'row', createPane('b', 'pwsh'), 's1');
    root = splitPane(root, 'b', 'column', createPane('c', 'wsl:Ubuntu'), 's2');
    expect(root.type === 'split' && root.children[1]).toMatchObject({ type: 'split', direction: 'column' });
    expect(ids(root)).toEqual(['a', 'b', 'c']);
  });

  it('closing a pane gives its space to siblings and collapses single-child splits', () => {
    let root: LayoutNode | null = splitPane(createPane('a', 'pwsh'), 'a', 'row', createPane('b', 'pwsh'), 's1');
    root = splitPane(root, 'b', 'column', createPane('c', 'pwsh'), 's2');
    root = removePane(root, 'c');
    expect(root).toMatchObject({ type: 'split', direction: 'row' });
    expect(ids(root)).toEqual(['a', 'b']);
    root = removePane(root!, 'a');
    expect(root).toEqual(createPane('b', 'pwsh'));
    expect(removePane(root!, 'b')).toBeNull();
  });

  it('flattens a nested split that ends up with the parent direction', () => {
    // row[a, column[b, row[c, d]]] -> remove b -> row[a, c, d]
    let root: LayoutNode = splitPane(createPane('a', 'p'), 'a', 'row', createPane('b', 'p'), 's1');
    root = splitPane(root, 'b', 'column', createPane('c', 'p'), 's2');
    root = splitPane(root, 'c', 'row', createPane('d', 'p'), 's3');
    const next = removePane(root, 'b')!;
    expect(next.type === 'split' && next.direction).toBe('row');
    expect(next.type === 'split' && next.children.map((c) => c.type)).toEqual(['pane', 'pane', 'pane']);
    expect(next.type === 'split' && sum(next.sizes)).toBeCloseTo(1);
  });

  it('keeps sizes normalised and clamps resizing to a minimum', () => {
    expect(normalizeSizes([1, 3])).toEqual([0.25, 0.75]);
    expect(normalizeSizes([0, 0])).toEqual([0.5, 0.5]);
    expect(resizeAt([0.5, 0.5], 0, 0.2)).toEqual([0.7, 0.30000000000000004]);
    const clamped = resizeAt([0.5, 0.5], 0, -1, 0.1);
    expect(clamped[0]).toBeCloseTo(0.1);
    expect(sum(clamped)).toBeCloseTo(1);
    expect(resizeAt([0.5, 0.5], 3, 0.1)).toEqual([0.5, 0.5]);
    expect(resizeAt([0.5, 0.5], 0, Number.NaN)).toEqual([0.5, 0.5]);
  });

  it('updates split proportions by id and rejects mismatched lengths', () => {
    const root = splitPane(createPane('a', 'p'), 'a', 'row', createPane('b', 'p'), 's1');
    expect(setSplitSizes(root, 's1', [3, 1])).toMatchObject({ sizes: [0.75, 0.25] });
    expect(setSplitSizes(root, 's1', [1])).toBe(root);
  });

  it('finds spatial neighbours for focus movement', () => {
    // row[a, column[b, c]]
    let root: LayoutNode = splitPane(createPane('a', 'p'), 'a', 'row', createPane('b', 'p'), 's1');
    root = splitPane(root, 'b', 'column', createPane('c', 'p'), 's2');
    expect(neighborPane(root, 'a', 'right')).toBe('b');
    expect(neighborPane(root, 'c', 'left')).toBe('a');
    expect(neighborPane(root, 'b', 'down')).toBe('c');
    expect(neighborPane(root, 'c', 'up')).toBe('b');
    expect(neighborPane(root, 'a', 'left')).toBeNull();
    const rects = computeRects(root);
    expect(rects.get('c')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('round-trips through validation (restore)', () => {
    let root: LayoutNode = splitPane(createPane('a', 'pwsh'), 'a', 'row', createPane('b', 'wsl:Ubuntu-22.04'), 's1');
    root = splitPane(root, 'b', 'column', createPane('c', 'windows-powershell'), 's2');
    root = setSplitSizes(root, 's1', [0.3, 0.7]);
    const restored = validateLayout(JSON.parse(JSON.stringify(root)));
    expect(restored).toEqual(root);
  });
});
