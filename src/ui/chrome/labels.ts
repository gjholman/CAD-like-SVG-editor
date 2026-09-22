/**
 * The words the chrome shows, and the small decisions behind them.
 *
 * Kept apart from the DOM on purpose: "what does the panel say about this
 * selection" and "is this sketch empty or fully defined" are real decisions
 * with edge cases (an empty sketch has zero degrees of freedom, which is true
 * and reads as though something has been pinned down), and they are worth
 * testing without a document, a canvas or a browser.
 */
import { constraintRefs, type Constraint, type Id, type SketchDocument } from '../../core/model';
import type { SolveResult } from '../../core/solver';
import type { ToolName } from '../editor';

/** The one-line hint under the toolbar, per tool. */
export const HINTS: Record<ToolName, string> = {
  select: 'Click to select, shift-click to add. Drag a point to move it. Middle-drag to pan, wheel to zoom.',
  line: 'Click to place points. Near-level and near-plumb segments pick up a relation; click the first point to close the shape.',
  arc: 'Click the centre, then the start, then sweep round to the end.',
};

/** Display names for every constraint kind, dimensions included. */
export const RELATION_NAMES: Record<string, string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  coincident: 'Coincident',
  fix: 'Fix',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  collinear: 'Collinear',
  tangent: 'Tangent',
  equal: 'Equal',
  concentric: 'Concentric',
  midpoint: 'Midpoint',
  symmetric: 'Symmetric',
  'point-on': 'Point on',
  distance: 'Distance',
  'horizontal-distance': 'Width',
  'vertical-distance': 'Height',
};

/** Sprite ids from the page's icon sheet. */
export const RELATION_ICONS: Record<string, string> = {
  horizontal: '#i-horizontal',
  vertical: '#i-vertical',
  coincident: '#i-coincident',
  fix: '#i-fix',
  parallel: '#i-parallel',
  perpendicular: '#i-perp',
  collinear: '#i-horizontal',
  tangent: '#i-tangent',
  equal: '#i-equal',
  concentric: '#i-circle',
  midpoint: '#i-coincident',
  symmetric: '#i-mirror',
  'point-on': '#i-link',
  distance: '#i-dim',
  'horizontal-distance': '#i-dim',
  'vertical-distance': '#i-dim',
};

/** What a relation acts on, in the ids the canvas shows. */
export function describeRefs(constraint: Constraint): string {
  const { points, entities } = constraintRefs(constraint);
  return [...points, ...entities].join(' and ');
}

export interface SelectionSummary {
  readonly name: string;
  readonly sub: string;
}

/**
 * A sentence for whatever is selected, so the panel is never just blank.
 *
 * Every branch says something a user can act on: a point gives its
 * coordinates and whether it can still move, an entity says whether it is
 * pinned down, a relation says what it acts on.
 */
export function summariseSelection(
  doc: SketchDocument,
  result: SolveResult,
  selection: readonly Id[],
): SelectionSummary {
  if (selection.length === 0) {
    return { name: 'Nothing selected', sub: 'Click geometry, or shift-click to select more.' };
  }
  if (selection.length > 1) {
    return { name: `${selection.length} selected`, sub: selection.join(', ') };
  }

  const id = selection[0]!;
  const point = doc.points[id];
  if (point !== undefined) {
    const moves = result.pointStatus[id] === 'fully-defined' ? 'fully defined' : 'can still move';
    return {
      name: `Point ${id}`,
      sub: `X ${point.x.toFixed(2)}, Y ${point.y.toFixed(2)} · ${moves}`,
    };
  }

  const entity = doc.entities[id];
  if (entity !== undefined) {
    const defined = result.entityStatus[id] === 'fully-defined' ? 'fully defined' : 'under defined';
    return {
      name: `${entity.kind[0]!.toUpperCase()}${entity.kind.slice(1)} ${id}`,
      sub: `${entity.construction ? 'Construction · ' : ''}${defined}`,
    };
  }

  const constraint = doc.constraints[id];
  if (constraint !== undefined) {
    return { name: RELATION_NAMES[constraint.kind] ?? constraint.kind, sub: describeRefs(constraint) };
  }
  return { name: '1 selected', sub: id };
}

export interface StatusLine {
  readonly text: string;
  /** Class for the status dot: '' is the healthy one. */
  readonly dot: string;
  /** The line underneath, counting the degrees of freedom. */
  readonly detail: string;
}

const STATUS = {
  'fully-defined': { text: 'Fully defined', dot: '' },
  'under-defined': { text: 'Under defined', dot: 'under' },
  'over-defined': { text: 'Over defined', dot: 'over' },
  unsolved: { text: 'No solution found', dot: 'unsolved' },
} as const;

/**
 * The status readout: what the solver found, and how much freedom is left.
 *
 * An empty sketch is called out separately. It has zero degrees of freedom,
 * which is arithmetically true and reads as though something has been pinned
 * down, so it says what it actually is instead.
 */
export function statusLine(doc: SketchDocument, result: SolveResult): StatusLine {
  if (Object.keys(doc.points).length === 0) {
    return { text: 'Empty sketch', dot: 'empty', detail: 'Pick the line tool to start drawing' };
  }
  const status = STATUS[result.status];
  return {
    text: status.text,
    dot: status.dot,
    detail: `${result.dof} ${result.dof === 1 ? 'degree' : 'degrees'} of freedom`,
  };
}
