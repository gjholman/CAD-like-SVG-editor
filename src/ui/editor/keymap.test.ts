// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RELATION_KEYS, RELATION_LABELS, handleKey, isTyping, type KeyActions } from './keymap';
import type { RelationKind } from './commands';

/** Records what a key event asked for, so the map can be read off directly. */
function recorder(): { actions: KeyActions; calls: string[] } {
  const calls: string[] = [];
  const actions: KeyActions = {
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    applyRelation: (kind) => calls.push(`relation:${kind}`),
    addDimension: () => calls.push('dimension'),
    toggleGrid: () => calls.push('grid'),
    deleteSelection: () => calls.push('delete'),
    cancel: () => calls.push('cancel'),
    setTool: (tool) => calls.push(`tool:${tool}`),
  };
  return { actions, calls };
}

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}, target?: EventTarget) {
  const { actions, calls } = recorder();
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...modifiers });
  if (target !== undefined) target.dispatchEvent(event);
  const handled = handleKey(event, actions);
  return { calls, handled, prevented: event.defaultPrevented };
}

describe('handleKey', () => {
  it.each([
    ['v', 'tool:select'],
    ['l', 'tool:line'],
    ['a', 'tool:arc'],
    ['d', 'dimension'],
    ['g', 'grid'],
    ['Escape', 'cancel'],
  ])('%s runs %s', (key, expected) => {
    expect(press(key).calls).toEqual([expected]);
  });

  it('takes a shortcut in either case', () => {
    expect(press('L').calls).toEqual(['tool:line']);
    expect(press('D').calls).toEqual(['dimension']);
  });

  it('deletes on either delete key, and stops the browser going back', () => {
    expect(press('Backspace').calls).toEqual(['delete']);
    expect(press('Backspace').prevented).toBe(true);
    expect(press('Delete').calls).toEqual(['delete']);
  });

  it('maps every relation key with shift held', () => {
    for (const [key, kind] of Object.entries(RELATION_KEYS)) {
      expect(press(key, { shiftKey: true }).calls).toEqual([`relation:${kind}`]);
    }
  });

  it('does not apply a relation without shift', () => {
    // `v` is both "vertical" and the select tool; shift is what tells them
    // apart, so a bare v must never add a constraint.
    expect(press('v').calls).toEqual(['tool:select']);
  });

  it('undoes and redoes on either accelerator', () => {
    expect(press('z', { ctrlKey: true }).calls).toEqual(['undo']);
    expect(press('z', { metaKey: true }).calls).toEqual(['undo']);
    expect(press('z', { ctrlKey: true, shiftKey: true }).calls).toEqual(['redo']);
    expect(press('y', { ctrlKey: true }).calls).toEqual(['redo']);
  });

  it('leaves other accelerators to the browser', () => {
    // Ctrl+S, Ctrl+A and friends belong to the page, not to the sketch.
    for (const key of ['s', 'a', 'l', 'd', 'g']) {
      expect(press(key, { ctrlKey: true }).calls).toEqual([]);
      expect(press(key, { ctrlKey: true }).prevented).toBe(false);
    }
  });

  it('ignores a key it has no binding for', () => {
    expect(press('q').handled).toBe(false);
    expect(press('q').calls).toEqual([]);
  });

  it('ignores everything typed into a text field', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const field = document.createElement(tag);
      document.body.append(field);
      for (const key of ['Backspace', 'd', 'l', 'g', 'z']) {
        expect(press(key, { ctrlKey: key === 'z' }, field).calls, `${tag} ${key}`).toEqual([]);
      }
      field.remove();
    }
  });

  it('ignores keys from a contenteditable element too', () => {
    // Set through the attribute, not the property: jsdom implements neither
    // `contentEditable` as a setter nor `isContentEditable`, so the property
    // route builds an element that only *looks* editable to a test. Checking
    // the attribute in the handler is what makes this testable at all.
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.append(div);
    expect(press('Backspace', {}, div).calls).toEqual([]);
    expect(press('l', {}, div).calls).toEqual([]);
    div.remove();
  });

  it('does not count contenteditable="false" as typing', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'false');
    document.body.append(div);
    expect(press('l', {}, div).calls).toEqual(['tool:line']);
    div.remove();
  });

  it('still acts on keys from the canvas', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(svg);
    expect(press('l', {}, svg).calls).toEqual(['tool:line']);
    svg.remove();
  });
});

describe('RELATION_LABELS', () => {
  it('names every relation a key can apply', () => {
    for (const kind of Object.values(RELATION_KEYS)) {
      expect(RELATION_LABELS[kind], kind).toBeTruthy();
    }
  });

  it('covers every relation kind, so no undo step is nameless', () => {
    const kinds: RelationKind[] = [
      'horizontal',
      'vertical',
      'coincident',
      'fix',
      'parallel',
      'perpendicular',
      'collinear',
      'tangent',
      'equal',
      'concentric',
      'midpoint',
      'symmetric',
    ];
    for (const kind of kinds) expect(RELATION_LABELS[kind], kind).toBeTruthy();
  });
});

describe('isTyping', () => {
  it('is false for nothing at all', () => {
    expect(isTyping(null)).toBe(false);
  });

  it('is false for a plain event target that is not an element', () => {
    expect(isTyping(new EventTarget())).toBe(false);
  });
});
