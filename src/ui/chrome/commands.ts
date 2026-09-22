/**
 * The chrome's controls: click a button, tell the editor, resync.
 *
 * Every handler here resyncs itself rather than relying on a global listener.
 * A global one would fire mid-click and rebuild the very control being
 * clicked — which is exactly how the relations panel's buttons once ended up
 * silently doing nothing.
 */
import type { Editor, RelationKind, ToolName } from '../editor';
import { all, q } from './dom';

/** Wires the toolbar, the relation buttons, the HUD and the panel headers. */
export function wireCommands(editor: Editor, sync: () => void): void {
  for (const button of all<HTMLButtonElement>('[data-tool]')) {
    button.addEventListener('click', () => {
      editor.setTool(button.dataset['tool'] as ToolName);
      sync();
    });
  }

  for (const button of all<HTMLButtonElement>('[data-relation]')) {
    button.addEventListener('click', () => {
      editor.applyRelation(button.dataset['relation'] as RelationKind);
      sync();
    });
  }

  const on = (selector: string, run: () => void) =>
    q(selector)?.addEventListener('click', () => {
      run();
      sync();
    });

  on('[data-action="dimension"]', () => editor.addDimension());
  on('[data-action="delete"]', () => editor.deleteSelection());
  on('[data-action="undo"]', () => editor.undo());
  on('[data-action="redo"]', () => editor.redo());
  on('[data-action="fit"]', () => editor.zoomToFit());
  on('[data-action="cross-layer"]', () => {
    // The button says which way it goes, so read that rather than recomputing.
    const button = q<HTMLButtonElement>('[data-action="cross-layer"]');
    editor.suspendCrossLayer(button?.dataset['suspend'] !== 'false');
  });

  for (const button of all<HTMLButtonElement>('[data-hud]')) {
    button.addEventListener('click', () => {
      const which = button.dataset['hud'];
      if (which === 'grid') editor.setGridVisible(!editor.isGridVisible());
      else if (which === 'snap') editor.setSnapping(!editor.isSnapping());
      else if (which === 'infer') editor.setInferring(!editor.isInferring());
      else editor.setDimensionsVisible(!editor.areDimensionsVisible());
      sync();
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
}
