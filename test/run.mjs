/* Headless harness for the PDF→EPUB core.

   Runs the exact folio.js pipeline against real PDFs through Node's pdfjs-dist,
   so reconstruction is verified by assertion instead of eyeballed in a browser.

   Usage:
     npm test                      # runs the asserted fixture suite
     node test/run.mjs <file.pdf>  # dumps the reconstruction of any PDF (debug)

   The browser feeds folio.js the same pdf.js text items this harness does, so a
   green run here means the conversion behaves the same in the app.
*/
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// folio.js is UMD; from an ES module it imports as a default object.
import Folio from "../folio.js";
const { fontStyle, buildLines, detectToc, analyze, toChapters, chapterXhtml, buildNav, buildNcx } = Folio;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Extract positioned text lines per page — the same input shape the browser
   builds from pdfjsLib.getDocument(...).getPage(p).getTextContent(). */
async function extractPages(pdfPath){
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  // verbosity:0 = errors only — silence the canvas/font polyfill warnings that
  // are irrelevant when we only pull text content (no rendering).
  const pdf = await pdfjsLib.getDocument({ data, verbosity:0 }).promise;
  const pages = [];
  const fontStyleById = new Map();   // PDF.js font id -> 'regular'|'bold'|'italic'|'bolditalic'
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    await resolveFonts(page, tc.items, fontStyleById);
    for(const it of tc.items) it.style = fontStyleById.get(it.fontName) || "regular";
    pages.push(buildLines(tc.items));
    page.cleanup();
  }
  return { pages, numPages: pdf.numPages };
}

/* Resolve the PostScript name behind each font id to a style. PDF.js only fills
   commonObjs once a page's operator list is built, so we force it — but only on
   pages that introduce a font id we haven't seen, keeping the cost bounded (the
   first 1–3 pages in practice). Mirrors readPdf() in index.html. */
async function resolveFonts(page, items, cache){
  const unseen = new Set();
  for(const it of items) if(it.fontName && !cache.has(it.fontName)) unseen.add(it.fontName);
  if(!unseen.size) return;
  try{ await page.getOperatorList(); }catch{ /* degrade to size-only */ }
  for(const id of unseen){
    let name=null;
    try{ const f=page.commonObjs.get(id); name=f && f.name; }catch{ /* not loaded */ }
    cache.set(id, fontStyle(name));
  }
}

function convert(pages, opts){
  const o = { headings:true, strip:true, dehyphen:true, ...opts };
  const toc = o.headings ? detectToc(pages) : null;
  const { blocks, tocMatched, tocTotal } = analyze(pages, o, null, toc);
  return { blocks, chapters: toChapters(blocks), tocMatched, tocTotal };
}

const paras  = blocks => blocks.filter(b => b.kind === "para");
const blockWith = (blocks, needle) => paras(blocks).find(b => b.text.includes(needle));

/* Stack-based XML well-formedness check (readers reject malformed nav/markup). */
function xmlError(xml, name){
  const s = xml.replace(/<\?[\s\S]*?\?>/g,"").replace(/<!DOCTYPE[^>]*>/gi,"").replace(/<!--[\s\S]*?-->/g,"");
  const stack=[]; const re=/<(\/?)([a-zA-Z0-9:]+)([^>]*?)(\/?)>/g; let m;
  while((m=re.exec(s))){
    const [, slash, tag, , self] = m;
    if(self) continue;
    if(slash){ const top=stack.pop(); if(top!==tag) return `${name}: </${tag}> but expected </${top||"?"}>`; }
    else stack.push(tag);
  }
  return stack.length ? `${name}: unclosed <${stack[stack.length-1]}>` : null;
}
function checkWellFormed(blocks, label){
  const chapters = toChapters(blocks);
  const parts = { nav: buildNav(chapters), ncx: buildNcx(chapters, "u", "T"),
                  ...Object.fromEntries(chapters.map((c,i) => ["chap"+(i+1), chapterXhtml(c)])) };
  const err = Object.entries(parts).map(([n,x]) => xmlError(x,n)).find(Boolean);
  check(`${label}: all EPUB parts are well-formed XML`, !err, err || "");
}

/* ---------- assertion plumbing ---------- */
let failures = 0;
function check(name, cond, detail){
  if(cond){ console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); failures++; }
}

/* ---------- debug dump mode: node test/run.mjs <file.pdf> ---------- */
const arg = process.argv[2];
if(arg){
  const { pages, numPages } = await extractPages(path.resolve(arg));
  const { blocks, chapters, tocMatched, tocTotal } = convert(pages);
  console.log(`pages=${numPages} blocks=${blocks.length} paras=${paras(blocks).length} ` +
              `headings=${blocks.filter(b=>b.kind==="heading").length} ` +
              `chapters=${chapters.length} toc=${tocMatched}/${tocTotal}`);
  const tagOf = b => b.kind === "heading" ? `H${b.level}`
                   : b.kind === "footnote" ? "fn"
                   : b.kind === "biblio"   ? "rf"
                   : "p ";
  blocks.forEach((b,i)=>{
    console.log(`[${String(i).padStart(3)}] ${tagOf(b)} ${b.text.slice(0,110)}`);
  });
  process.exit(0);
}

/* ---------- fixture suite ---------- */
console.log("fixture: sample.pdf (heading + 3 justified paragraphs)");
{
  const { pages } = await extractPages(path.join(HERE, "fixtures", "sample.pdf"));
  const { blocks } = convert(pages);

  // 1) "Chapter One" is recognised as a heading, not body text.
  check("Chapter One detected as heading",
    blocks.some(b => b.kind === "heading" && /chapter one/i.test(b.text)));

  // 2) Each source paragraph reconstructs as ONE block — not shattered per line.
  const fox = blockWith(blocks, "quick brown fox");
  check("fox paragraph is whole (not split mid-paragraph)",
    !!fox && fox.text.includes("valley below"),
    fox ? `ends with: "${fox.text.slice(-30)}"` : "block not found");

  const hobbit = blockWith(blocks, "hole in the ground");
  check("hobbit paragraph is whole",
    !!hobbit && hobbit.text.includes("comfort"),
    hobbit ? `ends with: "${hobbit.text.slice(-24)}"` : "block not found");

  // 3) No per-line shattering: a 3-paragraph page must yield a small block count.
  check("no per-line shattering (≤ 5 paragraphs)",
    paras(blocks).length <= 5,
    `got ${paras(blocks).length} paragraphs`);
}

console.log("\nfixture: structured.pdf (title, bold/numbered headings, inline emphasis)");
{
  const { pages } = await extractPages(path.join(HERE, "fixtures", "structured.pdf"));
  const { blocks } = convert(pages, { strip:false });
  const heading = (lvl, re) => blocks.some(b => b.kind === "heading" && b.level === lvl && re.test(b.text));
  const runIn = (needle, style) => {
    const b = blockWith(blocks, needle);
    return !!b && b.runs && b.runs.some(r => r.style === style && r.text.includes(needle));
  };

  check("title → h1", heading(1, /A Study of Small Things/));
  check("bold section → h2", heading(2, /^1\. Introduction/));
  check("numbered subsection → h3", heading(3, /^1\.1 Background/));         // regular font, numbering only
  check("italic word → italic run", runIn("emergent", "italic"));
  check("bold word → bold run", runIn("surprising", "bold"));

  const intro = blockWith(blocks, "This paper studies");
  check("emphasis paragraph stays whole",
    !!intro && intro.text.includes("broadly important"),
    intro ? `ends: "${intro.text.slice(-22)}"` : "not found");

  // nested nav: "1.1 Background" should sit under "1. Introduction"
  const chapters = toChapters(blocks);
  const nav = buildNav(chapters);
  const introIdx = nav.indexOf("1. Introduction");
  const subIdx   = nav.indexOf("1.1 Background");
  check("nav nests subsection under its section",
    introIdx >= 0 && subIdx > introIdx && nav.slice(introIdx, subIdx).includes("<ol>"),
    "no nested <ol> between section and subsection");
  check("headings carry anchor ids in chapter markup",
    chapters.map(chapterXhtml).join("").match(/<h3 id="h\d+"/));
  checkWellFormed(blocks, "structured");
}

console.log("\nfixture: notes.pdf (footnote at page foot + hanging-indent references)");
{
  const { pages } = await extractPages(path.join(HERE, "fixtures", "notes.pdf"));
  const { blocks } = convert(pages, { strip:false });
  const footnotes = blocks.filter(b => b.kind === "footnote");
  const biblio    = blocks.filter(b => b.kind === "biblio");

  // footnote pulled out of the body as its own kind, grouped across its two lines
  check("footnote detected as footnote (not paragraph)", footnotes.length === 1,
    `got ${footnotes.length}`);
  check("footnote grouped whole",
    footnotes[0] && footnotes[0].text.includes("test grouping"));
  check("footnote did not leak into a paragraph",
    !blocks.some(b => b.kind === "para" && b.text.includes("clarifying footnote")));

  // references split into individual hanging-indent entries
  check("two bibliography entries", biblio.length === 2, `got ${biblio.length}`);
  check("hanging-indent continuation joined into its entry",
    biblio.some(b => /^Smith, Jane/.test(b.text) && b.text.includes("Journal of Examples")));

  // serialization carries the structural classes
  const xh = toChapters(blocks).map(chapterXhtml).join("\n");
  check("footnote renders with class", /<p class="footnote">/.test(xh));
  check("bibliography renders with hanging-indent class", /<p class="biblio">/.test(xh));
  checkWellFormed(blocks, "notes");
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASSED");
process.exit(failures ? 1 : 0);
