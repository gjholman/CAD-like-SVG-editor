/**
 * The keyboard map, as data plus one dispatcher.
 *
 * Shortcuts follow the mockup: a bare letter picks a tool or runs a command,
 * and shift-plus-letter applies a relation to the selection. Keeping the map
 * here rather than inside the editor's closure means the bindings can be
 * listed (a help panel, a test) without an editor and a DOM.
 */
import type { RelationKind } from './commands';

/** Shift-plus-letter applies a relation to the selection, as in the mockup. */
export const RELATION_KEYS: Readonly<Record<string, RelationKind>> = {
  h: 'horizontal',
  v: 'vertical',
  c: 'coincident',
  f: 'fix',
  p: 'parallel',
  r: 'perpendicular',
  t: 'tangent',
  e: 'equal',
  s: 'symmetric',
};

/** Undo labels, which are also what the relation buttons are called. */
export const RELATION_LABELS: Readonly<Record<RelationKind, string>> = {
  horizontal: 'Add horizontal',
  vertical: 'Add vertical',
  coincident: 'Add coincident',
  fix: 'Fix point',
  parallel: 'Add parallel',
  perpendicular: 'Add perpendicular',
  collinear: 'Add collinear',
  tangent: 'Add tangent',
  equal: 'Add equal',
  concentric: 'Add concentric',
  midpoint: 'Add midpoint',
  symmetric: 'Add symmetric',
};

/** What a shortcut can ask for. The editor supplies these. */
export interface KeyActions {
  undo(): void;
  redo(): void;
  applyRelation(kind: RelationKind): void;
  addDimension(): void;
  toggleGrid(): void;
  deleteSelection(): void;
  /** Escape: abandon the tool in progress and clear the selection. */
  cancel(): void;
  setTool(tool: 'select' | 'line' | 'arc'): void;
}

/**
 * Is the event coming from somewhere the user is typing?
 *
 * The key handler is on the document so shortcuts work wherever the focus is,
 * which means it also sees every keystroke typed into the panel's dimension
 * fields — where `Backspace` deleting the selected geometry and `d` adding a
 * dimension are the last things anyone wants. Accelerators are included:
 * Ctrl+Z in a text field is that field's own undo, and undoing the sketch
 * behind it as well would be two undos for one keystroke.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;

  // The attribute as well as the property: jsdom does not implement
  // `isContentEditable`, so a test would pass here and the real browser would
  // not. An explicit contenteditable="false" is not typing.
  if (element.isContentEditable) return true;
  const editable = element.getAttribute?.('contenteditable');
  return editable === '' || editable === 'true' || editable === 'plaintext-only';
}

/**
 * Runs the shortcut a key event asks for, if any.
 *
 * Returns whether the event was handled, which is also whether the default was
 * prevented — a caller can use it, but nothing has to.
 */
export function handleKey(event: KeyboardEvent, actions: KeyActions): boolean {
  if (isTyping(event.target)) return false;

  const accel = event.metaKey || event.ctrlKey;
  const lower = event.key.toLowerCase();

  if (accel && lower === 'z') {
    event.preventDefault();
    if (event.shiftKey) actions.redo();
    else actions.undo();
    return true;
  }
  if (accel && lower === 'y') {
    event.preventDefault();
    actions.redo();
    return true;
  }
  if (accel) return false;

  if (event.shiftKey) {
    const relation = RELATION_KEYS[lower];
    if (relation !== undefined) {
      event.preventDefault();
      actions.applyRelation(relation);
      return true;
    }
  }

  switch (lower) {
    case 'd':
      actions.addDimension();
      return true;
    case 'g':
      actions.toggleGrid();
      return true;
    case 'backspace':
    case 'delete':
      event.preventDefault();
      actions.deleteSelection();
      return true;
    case 'escape':
      actions.cancel();
      return true;
    case 'v':
      actions.setTool('select');
      return true;
    case 'l':
      actions.setTool('line');
      return true;
    case 'a':
      actions.setTool('arc');
      return true;
    default:
      return false;
  }
}
