/**
 * Mounts the editor on sketch.html.
 *
 * This is the sandbox that makes Step 5 usable by hand: pick a tool, draw,
 * drag, undo. The designed chrome from the mockup (panels, relation buttons,
 * dimensions) arrives with Step 6.
 */
import './styles/canvas.css';
import './styles/sketch.css';
import { createEditor, type ToolName } from './ui/editor';
import { screenToWorld } from './ui/render';

const stage = document.querySelector('#stage');
if (stage === null) throw new Error('sketch.html is missing its canvas');

const editor = createEditor({ root: stage });

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tool]')];
const undoButton = document.querySelector<HTMLButtonElement>('[data-action="undo"]');
const redoButton = document.querySelector<HTMLButtonElement>('[data-action="redo"]');
const statusDot = document.querySelector('#status-dot');
const statusText = document.querySelector('#status-text');
const dofText = document.querySelector('#dof');
const hint = document.querySelector('#hint');
const coords = document.querySelector('#coords');

const HINTS: Record<ToolName, string> = {
  select: 'Click to select. Drag a point to move it. Middle-drag to pan, wheel to zoom.',
  line: 'Click to place points. Click an existing point to join to it. Esc ends the chain.',
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

function syncChrome(): void {
  const tool = editor.getTool();
  for (const button of toolButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
  }
  if (undoButton !== null) undoButton.disabled = !editor.canUndo();
  if (redoButton !== null) redoButton.disabled = !editor.canRedo();
  if (hint !== null) hint.textContent = HINTS[tool];

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
