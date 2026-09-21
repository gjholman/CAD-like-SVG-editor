/**
 * The native save format: our own JSON, as the plan decided.
 *
 * A saved file is the document and nothing else. History is not saved (also a
 * plan decision), and neither is the viewport, so opening a file puts you at
 * the geometry rather than at wherever the last person happened to be looking.
 *
 * Loading validates before handing the document back. A file from a future
 * version, or one that has been edited by hand into something inconsistent,
 * should fail loudly at the door rather than three steps later inside the
 * solver.
 */
import { DOCUMENT_VERSION, validate, type SketchDocument } from '../core/model';

/** Files carry the version they were written with, for migrations later. */
export interface SketchFile {
  readonly version: number;
  readonly document: SketchDocument;
}

export class SketchFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SketchFileError';
  }
}

/** Serialises a document. Indented, because these files get diffed. */
export function toJson(doc: SketchDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Parses a saved file, or throws `SketchFileError` saying what is wrong with
 * it. The document that comes back has passed `validate`.
 */
export function fromJson(text: string): SketchDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SketchFileError(`This file is not valid JSON: ${(cause as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SketchFileError('This file does not contain a sketch.');
  }

  const doc = parsed as SketchDocument;
  if (typeof doc.version !== 'number') {
    throw new SketchFileError('This file has no version, so it cannot be read as a sketch.');
  }
  if (doc.version > DOCUMENT_VERSION) {
    throw new SketchFileError(
      `This file was saved by a newer version (file ${doc.version}, this build reads ${DOCUMENT_VERSION}).`,
    );
  }
  // Older versions will migrate here once there is more than one.

  for (const field of ['points', 'entities', 'constraints', 'paths', 'layers'] as const) {
    if (typeof doc[field] !== 'object' || doc[field] === null) {
      throw new SketchFileError(`This file is missing its "${field}".`);
    }
  }
  if (!Array.isArray(doc.layerOrder)) {
    throw new SketchFileError('This file is missing its "layerOrder".');
  }

  const issues = validate(doc);
  if (issues.length > 0) {
    const listed = issues.slice(0, 3).map((issue) => issue.message).join('; ');
    const more = issues.length > 3 ? `, and ${issues.length - 3} more` : '';
    throw new SketchFileError(`This sketch is inconsistent: ${listed}${more}.`);
  }

  return doc;
}

/** A filename for a saved sketch, given the name the user is working under. */
export function suggestFilename(name = 'sketch'): string {
  const cleaned = name.trim().replace(/\.json$/i, '').replace(/[^\w. -]+/g, '') || 'sketch';
  return `${cleaned}.json`;
}
