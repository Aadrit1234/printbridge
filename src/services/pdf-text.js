'use strict';
/* What a standard PDF font can actually encode.
 *
 * pdf-lib's built-in fonts are WinAnsi-encoded, and serialising a character
 * outside that set throws — which used to fail a whole job on a document that
 * merely contained an em dash, a curly quote, an arrow or an accent. Real
 * documents from real people are full of those, so transliterate the common
 * ones to their ASCII meaning and leave anything else as a plain "?".
 * A slightly lossy print beats a document that refuses to print.
 *
 * Shared by the converter (text files) and the renderer (token pages, test
 * pages, QR cards) so both sides agree on what is safe to draw.
 */

const FALLBACK = new Map(Object.entries({
  '\u2018': "'", '\u2019': "'", '\u201A': ',', '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2013': '-', '\u2014': '--', '\u2015': '--', '\u2212': '-', '\u2010': '-', '\u2011': '-',
  '\u2026': '...', '\u2022': '*', '\u2039': '<', '\u203A': '>', '\u00AB': '<<', '\u00BB': '>>',
  '\u2192': '->', '\u2190': '<-', '\u21D2': '=>', '\u21D0': '<=', '\u2032': "'", '\u2033': '"',
  '\u20AC': 'EUR', '\u00A3': 'GBP', '\u00A5': 'JPY', '\u00A9': '(c)', '\u00AE': '(R)', '\u2122': '(TM)',
  '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u2009': ' ', '\u200A': ' ', '\u2002': ' ', '\u2003': ' ',
  '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '', '\u00AD': '-', '\u00B7': '*',
}));

/** Fold a string into what a standard PDF font can actually encode. */
function winAnsiSafe(value) {
  let out = '';
  for (const char of String(value == null ? '' : value)) {
    const code = char.codePointAt(0);
    if (code < 0x80) { out += char; continue; }
    const mapped = FALLBACK.get(char);
    if (mapped !== undefined) { out += mapped; continue; }
    // Latin-1 letters and friends: WinAnsi covers 0xA0–0xFF directly.
    if (code >= 0xA0 && code <= 0xFF) { out += char; continue; }
    out += '?';
  }
  return out;
}

module.exports = { winAnsiSafe };
