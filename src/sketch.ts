/**
 * Mounts the editor on sketch.html.
 *
 * This is the sandbox that makes Step 5 usable by hand: pick a tool, draw,
 * drag, undo. The designed chrome from the mockup (panels, relation buttons,
 * dimensions) arrives with Step 6.
 */
import './styles/canvas.css';
import './styles/sketch.css';
import { createEditor, type RelationKind, type ToolName } from './ui/editor';
import { formatValue, isDimension, screenToWorld } from './ui/render';

const stage = document.querySelector('#stage');
if (stage === null) throw new Error('sketch.html is missing its canvas');

const editor = createEditor({ root: stage });

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tool]')];
const relationButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-relation]')];
const dimensionButton = document.querySelector<HTMLButtonElement>('[data-action="dimension"]');
const relationList = document.querySelector('#relations');
const relationCount = document.querySelector('#relation-count');
const relationsEmpty = document.querySelector('#relations-empty');
const undoButton = document.querySelector<HTMLButtonElement>('[data-action="undo"]');
const redoButton = document.querySelector<HTMLButtonElement>('[data-action="redo"]');
const statusDot = document.querySelector('#status-dot');
const statusText = document.querySelector('#status-text');
const dofText = document.querySelector('#dof');
const hint = document.querySelector('#hint');
const coords = document.querySelector('#coords');

const HINTS: Record<ToolName, string> = {
  select: 'Click to select, shift-click to add. Drag a point to move it. Middle-drag to pan.',
  line: 'Click to place points. Click an existing point to join to it. Esc ends the chain.',
};

const RELATION_NAMES: Record<string, string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  coincident: 'Coincident',
  fix: 'Fix',
  'point-on': 'Point on',
  distance: 'Distance',
  'horizontal-distance': 'Width',
  'vertical-distance': 'Height',
};

const STATUS_TEXT = {
  'fully-defined': 'Fully defined',
  'under-defined': 'Under defined',
  'over-defined': 'Over defined',
  unsolved: 'No solution found',
} as const;

const STATUS_CLASS = {
  'fully-defined': '',
  'under-defined': 'under',
  'over-defined': 'over',
  unsolved: 'unsolved',
} as const;

/** What a relation acts on, in the ids the canvas shows on hover. */
function describe(constraint: { kind: string; point?: string; p1?: string; p2?: string }): string {
  if (constraint.point !== undefined) return constraint.point;
  if (constraint.p1 !== undefined && constraint.p2 !== undefined) {
    return `${constraint.p1} and ${constraint.p2}`;
  }
  return '';
}

/** Rebuilds the relations panel from the document. */
function syncRelations(): void {
  if (relationList === null) return;
  const doc = editor.getDocument();
  const conflicts = new Set(editor.getResult().conflicts);
  const selection = new Set(editor.getSelection());
  const entries = Object.values(doc.constraints);

  if (relationCount !== null) relationCount.textContent = String(entries.length);
  if (relationsEmpty !== null) {
    (relationsEmpty as HTMLElement).hidden = entries.length > 0;
  }

  relationList.replaceChildren();
  for (const constraint of entries) {
    const row = document.createElement('div');
    const classes = ['relation'];
    if (constraint.suspended === true) classes.push('suspended');
    if (conflicts.has(constraint.id)) classes.push('conflict');
    if (selection.has(constraint.id)) classes.push('selected');
    row.className = classes.join(' ');

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = RELATION_NAMES[constraint.kind] ?? constraint.kind;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = conflicts.has(constraint.id) ? 'Conflicting or redundant' : describe(constraint);
    text.append(name, sub);

    const acts = document.createElement('div');
    acts.className = 'acts';

    // A driving dimension is editable in place: changing the number is what
    // moves the geometry, which is the whole point of a parametric sketch.
    if (isDimension(constraint)) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = formatValue(constraint.value);
      input.setAttribute('aria-label', `${name.textContent} value`);
      // Not data-dimension: the canvas uses that to hit-test its annotations.
      input.dataset['dimensionInput'] = constraint.id;
      input.addEventListener('change', () => {
        const next = Number(input.value);
        if (!Number.isFinite(next)) {
          input.value = formatValue(constraint.value);
          return;
        }
        // Keep the sign the user never sees: the label shows magnitude, so a
        // right-to-left width must stay negative to mean the same thing.
        editor.setDimensionValue(constraint.id, constraint.value < 0 ? -next : next);
        syncChrome();
      });
      acts.append(input);
    }

    row.append(text, acts);
    relationList.append(row);
  }
}

function syncChrome(): void {
  const tool = editor.getTool();
  for (const button of toolButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
  }
  if (undoButton !== null) undoButton.disabled = !editor.canUndo();
  if (redoButton !== null) redoButton.disabled = !editor.canRedo();
  if (hint !== null) hint.textContent = HINTS[tool];

  for (const button of relationButtons) {
    button.disabled = !editor.canApply(button.dataset['relation'] as RelationKind);
  }
  if (dimensionButton !== null) dimensionButton.disabled = editor.planDimension() === undefined;
  syncRelations();

  const result = editor.getResult();
  // A sketch with no geometry has zero degrees of freedom, which is true but
  // reads as though something has been pinned down. Say what it is instead.
  const empty = Object.keys(editor.getDocument().points).length === 0;

  if (statusText !== null) statusText.textContent = empty ? 'Empty sketch' : STATUS_TEXT[result.status];
  if (statusDot !== null) {
    statusDot.setAttribute('class', `dotc ${empty ? 'empty' : STATUS_CLASS[result.status]}`);
  }
  if (dofText !== null) {
    dofText.textContent = empty
      ? 'Pick the line tool to start drawing'
      : `${result.dof} ${result.dof === 1 ? 'degree' : 'degrees'} of freedom`;
  }
}

for (const button of toolButtons) {
  button.addEventListener('click', () => {
    editor.setTool(button.dataset['tool'] as ToolName);
    syncChrome();
  });
}

for (const button of relationButtons) {
  button.addEventListener('click', () => {
    editor.applyRelation(button.dataset['relation'] as RelationKind);
    syncChrome();
  });
}

dimensionButton?.addEventListener('click', () => {
  editor.addDimension();
  syncChrome();
});

undoButton?.addEventListener('click', () => {
  editor.undo();
  syncChrome();
});
redoButton?.addEventListener('click', () => {
  editor.redo();
  syncChrome();
});
document.querySelector('[data-action="fit"]')?.addEventListener('click', () => editor.zoomToFit());

// The editor owns the document; the chrome just reflects it, so resync after
// anything that could have changed it.
for (const type of ['pointerup', 'keyup', 'pointerdown'] as const) {
  window.addEventListener(type, () => syncChrome());
}

stage.addEventListener('pointermove', (event) => {
  if (coords === null) return;
  const mouse = event as PointerEvent;
  const box = stage.getBoundingClientRect();
  const at = screenToWorld(editor.getViewport(), {
    x: mouse.clientX - box.left,
    y: mouse.clientY - box.top,
  });
  coords.textContent = `X ${at.x.toFixed(2)}  Y ${at.y.toFixed(2)} px`;
});

syncChrome();
