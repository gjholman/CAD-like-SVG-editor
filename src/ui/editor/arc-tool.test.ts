// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdGenerator, validate, type ArcEntity } from '../../core/model';
import { arcShape } from '../../core/geometry';
import { createEditor, type Editor } from './editor';
import { distanceToArc, hitTest } from './hit-test';

const SVG_NS = 'http://www.w3.org/2000/svg';
let stage: Element;
let editor: Editor;

beforeEach(() => {
  stage = document.createElementNS(SVG_NS, 'svg');
  document.body.replaceChildren(stage);
  editor = createEditor({ root: stage, document: createEmptyDocument(), nextId: createIdGenerator() });
});

afterEach(() => editor.destroy());

function move(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

function click(x: number, y: number): void {
  stage.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0, bubbles: true }));
}

/** Centre at (0,0), start at (100,0), sweeping through the given screen points. */
function drawQuarterArc(through: [number, number][] = [[71, 71]], end: [number, number] = [0, 100]): void {
  editor.setTool('arc');
  click(0, 0);
  click(100, 0);
  for (const [x, y] of through) move(x, y);
  click(end[0], end[1]);
}

const theArc = () => Object.values(editor.getDocument().entities)[0] as ArcEntity;

describe('the arc tool', () => {
  it('draws an arc from centre, start and end', () => {
    drawQuarterArc();
    const doc = editor.getDocument();

    expect(Object.keys(doc.entities)).toHaveLength(1);
    expect(theArc().kind).toBe('arc');
    expect(Object.keys(doc.points)).toHaveLength(3);
    expect(validate(doc)).toEqual([]);
  });

  it('puts the end point on the arc\'s own circle', () => {
    // Clicking short of the radius should still land on the circle, so the
    // sketch starts consistent rather than being pulled straight by the solver.
    drawQuarterArc([[71, 71]], [0, 40]);
    const shape = arcShape(theArc(), editor.getDocument().points)!;

    expect(shape.radius).toBeCloseTo(100, 6);
    const end = editor.getDocument().points[theArc().end]!;
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(100, 6);
  });

  it('takes its direction from the sweep the cursor traced', () => {
    drawQuarterArc([[71, 71]]);
    expect(theArc().clockwise).toBe(true);

    editor.undo();
    editor.undo();
    editor.undo();
    drawQuarterArc([[71, -71]], [0, -100]);
    expect(theArc().clockwise).toBe(false);
  });

  it('draws the long way round when the cursor goes the long way', () => {
    // Sweeping past half a turn is exactly what an accumulated angle catches
    // and a single end-position reading cannot.
    editor.setTool('arc');
    click(0, 0);
    click(100, 0);
    for (const [x, y] of [[71, 71], [0, 100], [-71, 71], [-100, 0], [-71, -71]] as const) move(x, y);
    click(0, -100);

    const shape = arcShape(theArc(), editor.getDocument().points)!;
    expect(theArc().clockwise).toBe(true);
    expect(shape.sweep).toBeGreaterThan(Math.PI);
  });

  it('shows a radius preview before the start point, and an arc after it', () => {
    editor.setTool('arc');
    click(0, 0);
    move(60, 0);
    expect(stage.querySelector('line.preview')).not.toBeNull();

    click(100, 0);
    move(71, 71);
    const preview = stage.querySelector('path.preview');
    expect(preview).not.toBeNull();
    expect(preview!.getAttribute('d')).toMatch(/^M100 0A100 100 0 /);
  });

  it('refuses a zero radius', () => {
    editor.setTool('arc');
    click(0, 0);
    click(0, 0);
    move(50, 50);
    click(50, 50);

    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);
  });

  it('does not reuse the centre as the end point', () => {
    // Clicking back on the centre to finish reused its id, which made the
    // arc's end its own centre: radius zero at one end and the real radius
    // at the other, so its implicit radius constraint could never hold and
    // the sketch reported unsolved. The click lands a new point instead.
    editor.setTool('arc');
    click(0, 0);
    click(100, 0);
    move(71, 71);
    move(0, 100);
    click(0, 0); // back on the centre

    const arc = theArc();
    expect(arc).not.toBeUndefined();
    expect(arc.end).not.toBe(arc.center);
    expect(arc.end).not.toBe(arc.start);
    expect(validate(editor.getDocument())).toEqual([]);
    expect(editor.getResult().converged).toBe(true);
  });

  it('refuses an arc with no sweep', () => {
    editor.setTool('arc');
    click(0, 0);
    click(100, 0);
    click(100, 0); // never moved, so nothing was swept

    expect(Object.keys(editor.getDocument().entities)).toHaveLength(0);
  });

  it('abandons an arc in progress when the tool changes', () => {
    editor.setTool('arc');
    click(0, 0);
    click(100, 0);
    editor.setTool('select');
    move(50, 50);

    expect(stage.querySelector('.preview')).toBeNull();
  });

  it('is reachable from the keyboard', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(editor.getTool()).toBe('arc');
  });
});

describe('arcs on the canvas', () => {
  it('render as a path with an A command', () => {
    drawQuarterArc();
    const path = stage.querySelector(`[data-entity="${theArc().id}"] path`)!;

    expect(path.getAttribute('d')).toMatch(/^M100 0A100 100 0 0 1 /);
  });

  it('are under defined until constrained, like any geometry', () => {
    drawQuarterArc();
    expect(stage.querySelector(`[data-entity="${theArc().id}"]`)!.getAttribute('class')).toContain(
      'is-under',
    );
  });
});

describe('picking an arc', () => {
  const shape = {
    centre: { x: 0, y: 0 },
    start: { x: 100, y: 0 },
    end: { x: 0, y: 100 },
    radius: 100,
    clockwise: true,
    startAngle: 0,
    endAngle: Math.PI / 2,
  };

  it('measures to the rim on the swept side', () => {
    expect(distanceToArc({ x: 74, y: 74 }, shape)).toBeCloseTo(Math.hypot(74, 74) - 100, 6);
  });

  it('measures to the nearer end off the swept side', () => {
    // Bottom-left is on the missing three quarters, so the nearest part of the
    // arc is an endpoint, not the rim beside the cursor.
    const p = { x: -100, y: 0 };
    expect(distanceToArc(p, shape)).toBeCloseTo(Math.hypot(-100 - 0, 0 - 100), 6);
  });

  it('can be clicked on its rim and not through its middle', () => {
    drawQuarterArc();
    const doc = editor.getDocument();
    const common = { doc, positions: doc.points, tolerance: 8 };

    expect(hitTest({ ...common, at: { x: 70.7, y: 70.7 } })?.id).toBe(theArc().id);
    expect(hitTest({ ...common, at: { x: 20, y: 20 } })).toBeUndefined();
    // The missing side of the circle is not pickable.
    expect(hitTest({ ...common, at: { x: -100, y: 0 } })).toBeUndefined();
  });

  it('can be selected and dragged by its centre', () => {
    drawQuarterArc();
    const centreId = theArc().center;
    // The arc tool stays armed after finishing one, so switch back first.
    editor.setTool('select');

    stage.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true }));
    move(40, 30);
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 30, button: 0, bubbles: true }));

    const moved = editor.getDocument().points[centreId]!;
    expect(moved.x).toBeCloseTo(40, 3);
    expect(moved.y).toBeCloseTo(30, 3);
    expect(validate(editor.getDocument())).toEqual([]);
  });
});
