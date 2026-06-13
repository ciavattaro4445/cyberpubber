# CyberPubber — PDF → EPUB

A browser-based converter that turns text PDFs into clean, reflowable EPUBs.
Everything runs locally in your browser — **your file is never uploaded anywhere**.

The app is `index.html` plus `folio.js` (the conversion core). No build step — open it
or host it as-is. `folio.js` is also loadable in Node, which is how the test suite
exercises the conversion against real PDFs.

Live at **https://ciavattaro4445.github.io/cyberpubber/**.

Open `index.html` in any browser, drop in a PDF, and download an EPUB.

## What it does

- **Parses** the PDF with [PDF.js](https://mozilla.github.io/pdf.js/) (the engine inside Firefox).
- **Reconstructs paragraphs** from positioned glyphs — rejoining the hard line breaks
  that PDFs put at the end of every visual line, so the EPUB actually reflows.
- **Recovers structure** by reading each glyph's font: the title and section/subsection
  headings (by size, weight, and "2.1"-style numbering), and **inline *italic* / bold**,
  which carry through as `<em>`/`<strong>`.
- **Separates footnotes** (small type at the page foot) and splits a **References /
  Bibliography** section into individual hanging-indent entries, instead of letting
  either bleed into the body text.
- **Builds a nested table of contents** (sections with their subsections) linked to
  anchors in the text.
- **Detects chapters** by finding the book's printed Contents page (by shape, wherever
  it sits) and matching each title to where it appears in the body. Falls back to the
  font/heading heuristics above when there's no usable Contents page.
- **Strips** repeating running heads and bare page numbers, and **mends** words
  hyphenated across line endings.
- **Packages** a valid EPUB 3 (with an EPUB 2 `toc.ncx` for older readers) using
  [JSZip](https://stuk.github.io/jszip/).

## Usage

1. Open `index.html` (double-click locally, or visit the hosted page — see below).
2. Optionally set Title / Author and toggle the detection options.
3. Choose a PDF and click **Bind into EPUB**.
4. Download the result (on iPhone: use **Save / Share EPUB** → *Save to Files* or open in Books).

An internet connection is needed the first time, because PDF.js and JSZip load from a CDN.
The PDF itself stays on your device.

## Limitations

- Best for **text-heavy prose** and single-column papers. Multi-column layouts, tables,
  and figures may come out imperfect. Footnotes are separated but not yet linked back to
  their in-text markers (they read as set-off notes, not pop-ups).
- **Scanned / image-only PDFs have no text to extract** and need OCR first (out of scope).
- Chapter detection relies on a Contents page with page numbers, or on heading typography;
  books with neither fall back to a single section.
- Large books run slower on mobile (the PDF.js worker can't always load there).

## Tests

The conversion core (`folio.js`) is verified headlessly against real PDFs:

```
npm install
npm test                       # runs the asserted fixture suite
node test/run.mjs some.pdf     # dumps the reconstruction of any PDF (debug)
```

The browser feeds `folio.js` the same PDF.js text items the harness does, so a green
run reflects the app's behavior.

## Hosting (optional)

Because it's static files, you can serve them free via **GitHub Pages**:
enable Pages on the repo (Settings → Pages → deploy from the `main` branch, root),
and the app will be live at `https://<user>.github.io/<repo>/`.

## License

MIT — see [LICENSE](LICENSE).
