export { createEditor, type Editor, type EditorOptions, type ToolName } from './editor';
export { createArcTool } from './arc-tool';
export { createLineTool, type LineTool } from './line-tool';
export { RELATION_KEYS, RELATION_LABELS, handleKey, isTyping, type KeyActions } from './keymap';
export type { DrawingTool, InferenceGuess, ToolContext } from './tool-context';
export { distanceToArc, distanceToSegment, hitTest, hitTestEntity, hitTestPoint, type Hit, type HitTestInput } from './hit-test';
export {
  canApplyRelation,
  describeSelection,
  dimensionEdit,
  dimensionPlan,
  pointPair,
  relationEdit,
  setDimensionValue,
  setSuspended,
  type DimensionKind,
  type DimensionPlan,
  type RelationKind,
  type Selection,
} from './commands';
