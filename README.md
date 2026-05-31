# Folio — PDF → EPUB

A single-file, browser-based converter that turns text PDFs into clean, reflowable EPUBs.
Everything runs locally in your browser — **your file is never uploaded anywhere**.

Open `index.html` in any browser, drop in a PDF, and download an EPUB.

## What it does

- **Parses** the PDF with [PDF.js](https://mozilla.github.io/pdf.js/) (the engine inside Firefox).
- **Reconstructs paragraphs** from positioned glyphs — rejoining the hard line breaks
  that PDFs put at the end of every visual line, so the EPUB actually reflows.
- **Detects chapters** by finding the book's printed Contents page (by shape, wherever
  it sits) and matching each title to where it appears in the body. Falls back to a
  font-size heuristic when there's no usable Contents page.
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

- Best for **text-heavy prose**. Multi-column layouts, tables, and footnotes may come out imperfect.
- **Scanned / image-only PDFs have no text to extract** and need OCR first (out of scope).
- Chapter detection relies on a Contents page with page numbers, or on heading typography;
  books with neither fall back to a single section.
- Large books run slower on mobile (the PDF.js worker can't always load there).

## Hosting (optional)

Because it's a static file, you can serve it free via **GitHub Pages**:
enable Pages on the repo (Settings → Pages → deploy from the `main` branch, root),
and the app will be live at `https://<user>.github.io/<repo>/`.

## License

MIT — see [LICENSE](LICENSE).
