/**
 * Saving, opening and exporting.
 *
 * All three go through the same dialog: the text is shown, and copy or
 * download take it from there. That keeps one code path whether the browser
 * allows a download or not, and it means a file that fails to open can show
 * the user what it actually contained.
 */
import { SketchFileError, fromJson, suggestFilename, toJson, toSvg } from '../../io';
import type { Editor } from '../editor';
import { q } from './dom';

/** Wires the save, export, open, copy and download controls. */
export function wireFiles(editor: Editor, sync: () => void): void {
  const dialog = q<HTMLDialogElement>('#output');
  const outputText = q<HTMLTextAreaElement>('#output-text');
  const fileInput = q<HTMLInputElement>('#file');
  /** What the download button would write, set by whatever opened the dialog. */
  let pending = { filename: 'sketch.json', type: 'application/json' };

  function showOutput(
    title: string,
    note: string,
    text: string,
    filename: string,
    type: string,
  ): void {
    if (dialog === null || outputText === null) return;
    const heading = q('#output-title');
    const noteEl = q('#output-note');
    if (heading !== null) heading.textContent = title;
    if (noteEl !== null) noteEl.textContent = note;
    outputText.value = text;
    pending = { filename, type };
    dialog.showModal();
    outputText.focus();
    outputText.select();
  }

  q('[data-action="save"]')?.addEventListener('click', () => {
    showOutput(
      'Save sketch',
      'The native format: geometry, relations and layers. History and the view are not saved.',
      toJson(editor.getDocument()),
      suggestFilename('sketch'),
      'application/json',
    );
  });

  q('[data-action="export"]')?.addEventListener('click', () => {
    const result = editor.getResult();
    showOutput(
      'Export SVG',
      'Construction geometry is left out; layers become groups. Relations and dimensions are not part of the output.',
      toSvg(editor.getDocument(), {
        positions: result.positions,
        radii: result.radii,
        margin: 8,
        inkscapeLayers: true,
      }),
      'sketch.svg',
      'image/svg+xml',
    );
  });

  q('[data-action="copy"]')?.addEventListener('click', () => {
    if (outputText === null) return;
    outputText.select();
    void navigator.clipboard?.writeText(outputText.value).catch(() => {
      // Clipboard access can be refused; the text is selected either way.
    });
  });

  q('[data-action="download"]')?.addEventListener('click', () => {
    if (outputText === null) return;
    const url = URL.createObjectURL(new Blob([outputText.value], { type: pending.type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = pending.filename;
    link.click();
    // The click starts the download asynchronously, so revoking the URL on this
    // same tick can pull the blob out from under it. Next tick is late enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  q('[data-action="open"]')?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => {
      try {
        editor.load(fromJson(text));
        editor.zoomToFit();
        sync();
      } catch (error) {
        // Say what is wrong with the file rather than failing silently.
        const message =
          error instanceof SketchFileError ? error.message : 'This file could not be opened.';
        showOutput('Could not open that file', message, text, file.name, 'application/json');
      }
      fileInput.value = '';
    });
  });
}
