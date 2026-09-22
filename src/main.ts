/**
 * The app: mounts the editor and wires up the chrome.
 *
 * The chrome follows docs/mockups/ui-mockup-v1.html, built out as far as the
 * features behind it exist. The editor owns the document; this file only
 * reflects it and forwards intent, so there is one source of truth and the
 * panels cannot drift from the sketch.
 */
import './styles/canvas.css';
import './styles/app.css';
import {
  createEditor,
  type Editor,
  type RelationKind,
  type ToolName,
} from './ui/editor';
import { formatValue, isDimension, screenToWorld, signedDimensionValue } from './ui/render';
import { SketchFileError, fromJson, suggestFilename, toJson, toSvg } from './io';
import { constraintRefs, type Constraint } from './core/model';

const stage = document.querySelector('#stage');
if (stage === null) throw new Error('index.html is missing its canvas');

const editor: Editor = createEditor({
  root: stage,
  // The HUD shows these on, so the app opts in to them.
  snapToGrid: true,
  showGrid: true,
  inferRelations: true,
});

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];

const toolButtons = all<HTMLButtonElement>('[data-tool]');
const relationButtons = all<HTMLButtonElement>('[data-relation]');
const hudButtons = all<HTMLButtonElement>('[data-hud]');
const dimensionButton = q<HTMLButtonElement>('[data-action="dimension"]');
const deleteButton = q<HTMLButtonElement>('[data-action="delete"]');
const undoButton = q<HTMLButtonElement>('[data-action="undo"]');
const redoButton = q<HTMLButtonElement>('[data-action="redo"]');

const HINTS: Record<ToolName, string> = {
  select: 'Click to select, shift-click to add. Drag a point to move it. Middle-drag to pan, wheel to zoom.',
  line: 'Click to place points. Near-level and near-plumb segments pick up a relation; click the first point to close the shape.',
  arc: 'Click the centre, then the start, then sweep round to the end.',
};

const RELATION_NAMES: Record<string, string> = {
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

const RELATION_ICONS: Record<string, string> = {
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

const STATUS = {
  'fully-defined': { text: 'Fully defined', dot: '' },
  'under-defined': { text: 'Under defined', dot: 'under' },
  'over-defined': { text: 'Over defined', dot: 'over' },
  unsolved: { text: 'No solution found', dot: 'unsolved' },
} as const;

function icon(href: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/** What a relation acts on, in the ids the canvas shows. */
function describe(constraint: Constraint): string {
  const { points, entities } = constraintRefs(constraint);
  return [...points, ...entities].join(' and ');
}

/** A sentence for whatever is selected, so the panel is never just blank. */
function describeSelection(): { name: string; sub: string } {
  const ids = editor.getSelection();
  const doc = editor.getDocument();
  if (ids.length === 0) {
    return { name: 'Nothing selected', sub: 'Click geometry, or shift-click to select more.' };
  }
  if (ids.length > 1) {
    return { name: `${ids.length} selected`, sub: ids.join(', ') };
  }

  const id = ids[0]!;
  if (Object.hasOwn(doc.points, id)) {
    const point = doc.points[id]!;
    const status = editor.getResult().pointStatus[id];
    return {
      name: `Point ${id}`,
      sub: `X ${point.x.toFixed(2)}, Y ${point.y.toFixed(2)} · ${status === 'fully-defined' ? 'fully defined' : 'can still move'}`,
    };
  }
  const entity = doc.entities[id];
  if (entity !== undefined) {
    const status = editor.getResult().entityStatus[id];
    return {
      name: `${entity.kind[0]!.toUpperCase()}${entity.kind.slice(1)} ${id}`,
      sub: `${entity.construction ? 'Construction · ' : ''}${status === 'fully-defined' ? 'fully defined' : 'under defined'}`,
    };
  }
  const constraint = doc.constraints[id];
  if (constraint !== undefined) {
    return { name: RELATION_NAMES[constraint.kind] ?? constraint.kind, sub: describe(constraint) };
  }
  return { name: '1 selected', sub: id };
}

let relationsSignature = '';

/**
 * Rebuilds the relations list, but only when something in it changed.
 *
 * Replacing the rows on every resync would tear out the row a click landed
 * on before the click event reached it, so the panel's own buttons would
 * silently do nothing.
 */
function syncRelations(): void {
  const list = q('#relations');
  if (list === null) return;

  const doc = editor.getDocument();
  const conflicts = new Set(editor.getResult().conflicts);
  const selection = new Set(editor.getSelection());
  const entries = Object.values(doc.constraints);

  const signature = JSON.stringify([
    entries.map((c) => [c.id, c.kind, 'value' in c ? c.value : null, c.suspended ?? false]),
    [...selection],
    [...conflicts],
  ]);
  if (signature === relationsSignature) return;
  relationsSignature = signature;

  const count = q('#relation-count');
  if (count !== null) count.textContent = String(entries.length);
  const empty = q<HTMLElement>('#relations-empty');
  if (empty !== null) empty.hidden = entries.length > 0;

  list.replaceChildren();
  for (const constraint of entries) {
    const row = document.createElement('div');
    const classes = ['relation'];
    if (constraint.suspended === true) classes.push('suspended');
    if (conflicts.has(constraint.id)) classes.push('conflict');
    if (selection.has(constraint.id)) classes.push('selected');
    row.className = classes.join(' ');
    row.append(icon(RELATION_ICONS[constraint.kind] ?? '#i-link'));

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
    // moves the geometry, which is the point of a parametric sketch.
    if (isDimension(constraint)) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = formatValue(constraint.value);
      input.id = `dim-${constraint.id}`;
      input.setAttribute('aria-label', `${name.textContent} value`);
      input.addEventListener('change', () => {
        const next = Number(input.value);
        if (!Number.isFinite(next)) {
          input.value = formatValue(constraint.value);
          return;
        }
        // The label shows a magnitude, so a right-to-left pick keeps its sign.
        editor.setDimensionValue(constraint.id, signedDimensionValue(constraint.value, next));
        syncChrome();
      });
      acts.append(input);
    }

    const suspended = constraint.suspended === true;
    const pause = document.createElement('button');
    pause.title = suspended ? 'Resume relation' : 'Suspend relation';
    pause.setAttribute('aria-label', pause.title);
    pause.append(icon(suspended ? '#i-play' : '#i-pause', 14));
    pause.addEventListener('click', () => {
      editor.setSuspended(constraint.id, !suspended);
      syncChrome();
    });

    const remove = document.createElement('button');
    remove.title = 'Delete relation';
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon('#i-trash', 14));
    remove.addEventListener('click', () => {
      editor.setSelection([constraint.id]);
      editor.deleteSelection();
      syncChrome();
    });

    acts.append(pause, remove);
    row.append(text, acts);
    // Selecting the row highlights what the relation acts on, on the canvas.
    row.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button, input') !== null) return;
      editor.setSelection([constraint.id]);
      syncChrome();
    });
    list.append(row);
  }
}

function syncChrome(): void {
  const tool = editor.getTool();
  for (const button of toolButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
  }
  for (const button of relationButtons) {
    button.disabled = !editor.canApply(button.dataset['relation'] as RelationKind);
  }
  if (dimensionButton !== null) dimensionButton.disabled = editor.planDimension() === undefined;
  if (deleteButton !== null) deleteButton.disabled = editor.getSelection().length === 0;
  if (undoButton !== null) undoButton.disabled = !editor.canUndo();
  if (redoButton !== null) redoButton.disabled = !editor.canRedo();

  const hint = q('#hint');
  if (hint !== null) hint.textContent = HINTS[tool];

  const selected = describeSelection();
  const selName = q('#sel-name');
  const selSub = q('#sel-sub');
  if (selName !== null) selName.textContent = selected.name;
  if (selSub !== null) selSub.textContent = selected.sub;

  for (const button of hudButtons) {
    const which = button.dataset['hud'];
    const on =
      which === 'grid'
        ? editor.isGridVisible()
        : which === 'snap'
          ? editor.isSnapping()
          : which === 'infer'
            ? editor.isInferring()
            : editor.areDimensionsVisible();
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }

  syncRelations();

  const result = editor.getResult();
  // A sketch with no geometry has zero degrees of freedom, which is true but
  // reads as though something has been pinned down. Say what it is instead.
  const empty = Object.keys(editor.getDocument().points).length === 0;
  const status = STATUS[result.status];

  const dot = q('#status-dot');
  const text = q('#status-text');
  const dof = q('#dof');
  if (text !== null) text.textContent = empty ? 'Empty sketch' : status.text;
  if (dot !== null) dot.setAttribute('class', `dotc ${empty ? 'empty' : status.dot}`);
  if (dof !== null) {
    dof.textContent = empty
      ? 'Pick the line tool to start drawing'
      : `${result.dof} ${result.dof === 1 ? 'degree' : 'degrees'} of freedom`;
  }
}

// Tools and commands --------------------------------------------------------
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

const on = (selector: string, run: () => void) =>
  q(selector)?.addEventListener('click', () => {
    run();
    syncChrome();
  });

on('[data-action="dimension"]', () => editor.addDimension());
on('[data-action="delete"]', () => editor.deleteSelection());
on('[data-action="undo"]', () => editor.undo());
on('[data-action="redo"]', () => editor.redo());
on('[data-action="fit"]', () => editor.zoomToFit());

for (const button of hudButtons) {
  button.addEventListener('click', () => {
    const which = button.dataset['hud'];
    if (which === 'grid') editor.setGridVisible(!editor.isGridVisible());
    else if (which === 'snap') editor.setSnapping(!editor.isSnapping());
    else if (which === 'infer') editor.setInferring(!editor.isInferring());
    else editor.setDimensionsVisible(!editor.areDimensionsVisible());
    syncChrome();
  });
}

// Collapsible panels, as in the mockup.
for (const head of all<HTMLButtonElement>('.panel-head')) {
  head.addEventListener('click', () => {
    const panel = head.closest('.panel');
    if (panel === null) return;
    const collapsed = panel.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
  });
}

// Saving, opening and exporting --------------------------------------------
const dialog = q<HTMLDialogElement>('#output');
const outputText = q<HTMLTextAreaElement>('#output-text');
const fileInput = q<HTMLInputElement>('#file');
let pending = { filename: 'sketch.json', type: 'application/json' };

function showOutput(title: string, note: string, text: string, filename: string, type: string): void {
  if (dialog === null || outputText === null) return;
  const heading = q('#output-title');
  const noteEl = q('#output-note');
  if (heading !== null) heading.textContent = title;
  if (noteEl !== null) noteEl.textContent = note;
  outputText.value = text;
  pending = { filename, type };
  dialog.showModal();
  outputText.focus();
  outputText.select();
}

q('[data-action="save"]')?.addEventListener('click', () => {
  showOutput(
    'Save sketch',
    'The native format: geometry, relations and layers. History and the view are not saved.',
    toJson(editor.getDocument()),
    suggestFilename('sketch'),
    'application/json',
  );
});

q('[data-action="export"]')?.addEventListener('click', () => {
  const result = editor.getResult();
  showOutput(
    'Export SVG',
    'Construction geometry is left out; layers become groups. Relations and dimensions are not part of the output.',
    toSvg(editor.getDocument(), {
      positions: result.positions,
      radii: result.radii,
      margin: 8,
      inkscapeLayers: true,
    }),
    'sketch.svg',
    'image/svg+xml',
  );
});

q('[data-action="copy"]')?.addEventListener('click', () => {
  if (outputText === null) return;
  outputText.select();
  void navigator.clipboard?.writeText(outputText.value).catch(() => {
    // Clipboard access can be refused; the text is selected either way.
  });
});

q('[data-action="download"]')?.addEventListener('click', () => {
  if (outputText === null) return;
  const url = URL.createObjectURL(new Blob([outputText.value], { type: pending.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = pending.filename;
  link.click();
  // The click starts the download asynchronously, so revoking the URL on this
  // same tick can pull the blob out from under it. Next tick is late enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

q('[data-action="open"]')?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file === undefined) return;
  void file.text().then((text) => {
    try {
      editor.load(fromJson(text));
      editor.zoomToFit();
      syncChrome();
    } catch (error) {
      // Say what is wrong with the file rather than failing silently.
      const message = error instanceof SketchFileError ? error.message : 'This file could not be opened.';
      showOutput('Could not open that file', message, text, file.name, 'application/json');
    }
    fileInput.value = '';
  });
});

// The editor owns the document; the chrome reflects it, so resync after
// anything that could have changed it. These listen on the canvas and the
// keyboard only: the chrome's own controls resync themselves, and a global
// listener here would fire mid-click and rebuild the control being clicked.
for (const type of ['pointerdown', 'pointerup', 'wheel'] as const) {
  stage.addEventListener(type, () => syncChrome());
}
// A drag can finish outside the canvas, and shortcuts are global.
window.addEventListener('keyup', () => syncChrome());
window.addEventListener('pointerup', (event) => {
  if ((event.target as Element | null)?.closest('.panels, .menubar, .hud, dialog') !== null) return;
  syncChrome();
});

stage.addEventListener('pointermove', (event) => {
  const coords = q('#coords');
  if (coords === null) return;
  const mouse = event as PointerEvent;
  const box = stage.getBoundingClientRect();
  const at = screenToWorld(editor.getViewport(), {
    x: mouse.clientX - box.left,
    y: mouse.clientY - box.top,
  });
  coords.textContent = `X ${at.x.toFixed(2)}  Y ${at.y.toFixed(2)} px`;
});

// The canvas fills its pane, so a resize changes how much grid to draw.
window.addEventListener('resize', () => editor.refresh());

syncChrome();
