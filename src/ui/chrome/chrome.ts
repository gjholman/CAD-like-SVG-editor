/**
 * Reflecting the editor in the panels.
 *
 * The editor owns the document; this only reads it. Everything here is a
 * one-way sync — state out of the editor, text and disabled flags into the
 * DOM — so the panels cannot drift from the sketch, and nothing in this file
 * ever edits a document directly.
 */
import { formatValue, isDimension, signedDimensionValue } from '../render';
import type { Editor, RelationKind } from '../editor';
import { all, icon, q } from './dom';
import { HINTS, RELATION_ICONS, RELATION_NAMES, describeRefs, statusLine, summariseSelection } from './labels';

export interface Chrome {
  /** Reads the editor and updates every panel. */
  sync(): void;
}

export function createChrome(editor: Editor): Chrome {
  const toolButtons = all<HTMLButtonElement>('[data-tool]');
  const relationButtons = all<HTMLButtonElement>('[data-relation]');
  const hudButtons = all<HTMLButtonElement>('[data-hud]');
  const dimensionButton = q<HTMLButtonElement>('[data-action="dimension"]');
  const deleteButton = q<HTMLButtonElement>('[data-action="delete"]');
  const undoButton = q<HTMLButtonElement>('[data-action="undo"]');
  const redoButton = q<HTMLButtonElement>('[data-action="redo"]');

  /** What the relations list was last built from; see `syncRelations`. */
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
      sub.textContent = conflicts.has(constraint.id)
        ? 'Conflicting or redundant'
        : describeRefs(constraint);
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
          sync();
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
        sync();
      });

      const remove = document.createElement('button');
      remove.title = 'Delete relation';
      remove.setAttribute('aria-label', remove.title);
      remove.append(icon('#i-trash', 14));
      remove.addEventListener('click', () => {
        editor.setSelection([constraint.id]);
        editor.deleteSelection();
        sync();
      });

      acts.append(pause, remove);
      row.append(text, acts);
      // Selecting the row highlights what the relation acts on, on the canvas.
      row.addEventListener('click', (event) => {
        if ((event.target as Element).closest('button, input') !== null) return;
        editor.setSelection([constraint.id]);
        sync();
      });
      list.append(row);
    }
  }

  function sync(): void {
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

    const selected = summariseSelection(editor.getDocument(), editor.getResult(), editor.getSelection());
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

    const status = statusLine(editor.getDocument(), editor.getResult());
    const dot = q('#status-dot');
    const text = q('#status-text');
    const dof = q('#dof');
    if (text !== null) text.textContent = status.text;
    if (dot !== null) dot.setAttribute('class', `dotc ${status.dot}`);
    if (dof !== null) dof.textContent = status.detail;
  }

  return { sync };
}
