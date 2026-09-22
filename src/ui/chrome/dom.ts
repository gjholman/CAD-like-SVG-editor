/** The handful of DOM helpers the chrome modules share. */

export const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);

export const all = <T extends Element>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];

/** An `<svg><use>` pointing at the page's icon sheet. */
export function icon(href: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}
