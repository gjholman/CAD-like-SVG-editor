/**
 * The app: mounts the editor and wires up the chrome.
 *
 * The chrome follows docs/mockups/ui-mockup-v1.html, built out as far as the
 * features behind it exist. The editor owns the document; the chrome only
 * reflects it and forwards intent, so there is one source of truth and the
 * panels cannot drift from the sketch.
 *
 * The parts live in `ui/chrome`: `chrome.ts` reflects the editor into the
 * panels, `commands.ts` wires the buttons, `files.ts` handles save, open and
 * export. What is left here is the mount and the listeners that belong to the
 * window rather than to any one control.
 */
import './styles/canvas.css';
import './styles/app.css';
import { createEditor, type Editor } from './ui/editor';
import { screenToWorld } from './ui/render';
import { createChrome, wireCommands, wireFiles } from './ui/chrome';

const stage = document.querySelector('#stage');
if (stage === null) throw new Error('index.html is missing its canvas');

const editor: Editor = createEditor({
  root: stage,
  // The HUD shows these on, so the app opts in to them.
  snapToGrid: true,
  showGrid: true,
  inferRelations: true,
});

const chrome = createChrome(editor);
const sync = () => chrome.sync();

wireCommands(editor, sync);
wireFiles(editor, sync);

// The editor owns the document; the chrome reflects it, so resync after
// anything that could have changed it. These listen on the canvas and the
// keyboard only: the chrome's own controls resync themselves, and a global
// listener here would fire mid-click and rebuild the control being clicked.
for (const type of ['pointerdown', 'pointerup', 'wheel'] as const) {
  stage.addEventListener(type, sync);
}
// A drag can finish outside the canvas, and shortcuts are global.
window.addEventListener('keyup', sync);
window.addEventListener('pointerup', (event) => {
  if ((event.target as Element | null)?.closest('.panels, .menubar, .hud, dialog') !== null) return;
  sync();
});

stage.addEventListener('pointermove', (event) => {
  const coords = document.querySelector('#coords');
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

sync();
