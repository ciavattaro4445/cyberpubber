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
const { buildLines, detectToc, analyze, toChapters } = Folio;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Extract positioned text lines per page — the same input shape the browser
   builds from pdfjsLib.getDocument(...).getPage(p).getTextContent(). */
async function extractPages(pdfPath){
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  // verbosity:0 = errors only — silence the canvas/font polyfill warnings that
  // are irrelevant when we only pull text content (no rendering).
  const pdf = await pdfjsLib.getDocument({ data, verbosity:0 }).promise;
  const pages = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    pages.push(buildLines(tc.items));
    page.cleanup();
  }
  return { pages, numPages: pdf.numPages };
}

function convert(pages, opts){
  const o = { headings:true, strip:true, dehyphen:true, ...opts };
  const toc = o.headings ? detectToc(pages) : null;
  const { blocks, tocMatched, tocTotal } = analyze(pages, o, null, toc);
  return { blocks, chapters: toChapters(blocks), tocMatched, tocTotal };
}

const paras  = blocks => blocks.filter(b => b.kind === "para");
const blockWith = (blocks, needle) => paras(blocks).find(b => b.text.includes(needle));

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
  blocks.forEach((b,i)=>{
    const tag = b.kind === "heading" ? `H${b.level}` : "p ";
    console.log(`[${String(i).padStart(3)}] ${tag} ${b.text.slice(0,110)}`);
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

console.log(failures ? `\nFAILED (${failures})` : "\nPASSED");
process.exit(failures ? 1 : 0);
