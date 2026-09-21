/**
 * The app: mounts the editor on the index page.
 *
 * The chrome here is deliberately plain. The designed editor chrome lives in
 * docs/mockups/ui-mockup-v1.html (tool rail, panel stack, rulers) and is built
 * out as the features behind it land; this is the working surface in the
 * meantime. The landing page moved to about.html.
 */
import './styles/canvas.css';
import './styles/sketch.css';
import { createEditor, type RelationKind, type ToolName } from './ui/editor';
import { formatValue, isDimension, screenToWorld } from './ui/render';
import { SketchFileError, fromJson, suggestFilename, toJson, toSvg } from './io';

const stage = document.querySelector('#stage');
if (stage === null) throw new Error('index.html is missing its canvas');

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
  arc: 'Click the centre, then the start, then sweep round and click the end.',
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

// Saving and exporting ------------------------------------------------------
const dialog = document.querySelector<HTMLDialogElement>('#output');
const outputTitle = document.querySelector('#output-title');
const outputNote = document.querySelector('#output-note');
const outputText = document.querySelector<HTMLTextAreaElement>('#output-text');
const fileInput = document.querySelector<HTMLInputElement>('#file');

let pending = { filename: 'sketch.json', type: 'application/json' };

/**
 * Shows a file's contents. Some embedded viewers block downloads outright, so
 * the text is always on screen to copy and the download is the convenience.
 */
function showOutput(title: string, note: string, text: string, filename: string, type: string): void {
  if (dialog === null || outputText === null) return;
  if (outputTitle !== null) outputTitle.textContent = title;
  if (outputNote !== null) outputNote.textContent = note;
  outputText.value = text;
  pending = { filename, type };
  dialog.showModal();
  outputText.focus();
  outputText.select();
}

document.querySelector('[data-action="save"]')?.addEventListener('click', () => {
  const text = toJson(editor.getDocument());
  showOutput(
    'Save sketch',
    'The native format: geometry, relations and layers. History and the view are not saved.',
    text,
    suggestFilename('sketch'),
    'application/json',
  );
});

document.querySelector('[data-action="export"]')?.addEventListener('click', () => {
  const result = editor.getResult();
  const svg = toSvg(editor.getDocument(), {
    positions: result.positions,
    radii: result.radii,
    margin: 8,
    inkscapeLayers: true,
  });
  showOutput(
    'Export SVG',
    'Construction geometry is left out; layers become groups. Relations and dimensions are not part of the output.',
    svg,
    'sketch.svg',
    'image/svg+xml',
  );
});

document.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
  if (outputText === null) return;
  outputText.select();
  void navigator.clipboard?.writeText(outputText.value).catch(() => {
    // Clipboard access can be refused; the text is selected either way.
  });
});

document.querySelector('[data-action="download"]')?.addEventListener('click', () => {
  if (outputText === null) return;
  const url = URL.createObjectURL(new Blob([outputText.value], { type: pending.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = pending.filename;
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector('[data-action="open"]')?.addEventListener('click', () => fileInput?.click());

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
