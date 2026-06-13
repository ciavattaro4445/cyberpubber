/* ============================================================================
   folio.js — the PDF→EPUB core, as a UMD module.

   This file never imports PDF.js. It operates on plain data that the caller has
   already extracted (text items with positions, per page), so the exact same
   code runs in the browser (index.html, using the global pdfjsLib) and in Node
   (test/run.mjs, using pdfjs-dist). That parity is the whole point: the pipeline
   is verified headlessly against real PDFs instead of guessed at.

   Why UMD and not an ES module: the app is meant to be opened by double-clicking
   index.html (file://), where ES-module imports are CORS-blocked. A classic
   <script src="folio.js"> loads fine from file://, so we expose a global
   `Folio` in the browser and module.exports in Node — no build step, double-
   click still works.

   Pipeline:
     buildLines(items)        glyphs        → visual lines
     analyze(pages, …)        lines         → a document model (the IR)
     toChapters(doc.blocks)   IR blocks     → chapters
     *Xhtml / buildOpf / …    chapters      → EPUB part strings

   The IR (document model):
     Doc   = { blocks: Block[], tocMatched, tocTotal }
     Block =
       | { kind:'heading', level:1|2|3, text, chapter?:boolean }
       | { kind:'para',    text }
     Inline runs and further block kinds (footnote, biblio, figure) arrive in
     later stages; serialization already routes on `kind` so adding them is
     local.
   ============================================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;  // Node / CommonJS
  else root.Folio = api;                                                      // browser global
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* ---------- small numeric helpers ---------- */
function mode(nums){
  const m=new Map(); let best=nums[0]||0,bc=0;
  for(const n of nums){const k=Math.round(n);const c=(m.get(k)||0)+1;m.set(k,c);if(c>bc){bc=c;best=k;}}
  return best;
}
function median(nums){ if(!nums.length)return 0; const s=[...nums].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

/* ---------- font style ----------
   The caller resolves each glyph's PostScript font name (e.g. "Utopia-Bold")
   and we reduce it to one of four styles. Keeping this here means the browser
   and the test harness classify identically; folio.js stays PDF.js-free. */
function fontStyle(name){
  if(!name) return "regular";
  const n=String(name).toLowerCase();
  const bold=/(bold|black|heavy|semibold|demibold|extrabold|ultra)/.test(n);
  const ital=/(italic|oblique|cursive|kursiv)/.test(n);
  return bold&&ital ? "bolditalic" : bold ? "bold" : ital ? "italic" : "regular";
}

/* Merge adjacent runs that share a style, trim the outer whitespace, drop
   empties. Runs are { text, style } where style ∈ regular|bold|italic|bolditalic. */
function collapseRuns(runs){
  const out=[];
  for(const r of runs){
    if(!r.text) continue;
    const last=out[out.length-1];
    if(last && last.style===r.style) last.text+=r.text;
    else out.push({text:r.text, style:r.style});
  }
  if(out.length){
    out[0].text=out[0].text.replace(/^\s+/,"");
    out[out.length-1].text=out[out.length-1].text.replace(/\s+$/,"");
  }
  return out.filter(r=>r.text);
}
/* The style covering the most characters in a line — its "dominant" style. */
function dominantStyle(runs){
  const tally=new Map();
  for(const r of runs){ tally.set(r.style,(tally.get(r.style)||0)+r.text.length); }
  let best="regular",bc=-1;
  for(const [s,c] of tally) if(c>bc){bc=c;best=s;}
  return best;
}

/* ============================================================================
   STEP 1 — group raw glyph items into visual lines, with sensible word spacing.
   `items` are PDF.js text items: { str, transform:[a,b,c,d,x,y], width, height }.
   ============================================================================ */
function buildLines(items){
  const its=items.filter(it=>it.str && it.str.length).map(it=>({
    str:it.str,
    x:it.transform[4],
    y:it.transform[5],
    w:it.width||0,
    h:it.height||Math.hypot(it.transform[1],it.transform[3])||10,
    style:it.style||"regular"
  }));
  if(!its.length) return [];
  its.sort((a,b)=> (b.y-a.y) || (a.x-b.x));
  const lines=[];
  for(const it of its){
    const last=lines[lines.length-1];
    const tol=Math.max(it.h,(last?last.h:0))*0.5;
    if(last && Math.abs(last.y-it.y)<=tol){ last.items.push(it); last.h=Math.max(last.h,it.h); }
    else lines.push({y:it.y,h:it.h,items:[it]});
  }
  for(const ln of lines){
    ln.items.sort((a,b)=>a.x-b.x);
    let text="",prev=null; const runs=[];
    const addRun=(t,style)=>{ const last=runs[runs.length-1];
      if(last && last.style===style) last.text+=t; else runs.push({text:t,style}); };
    for(const it of ln.items){
      const style=it.style||"regular";
      if(prev){
        const gap=it.x-(prev.x+prev.w);
        if(gap>it.h*0.28 && !/\s$/.test(text) && !/^\s/.test(it.str)){ text+=" "; addRun(" ",style); }
      }
      text+=it.str; addRun(it.str,style); prev=it;
    }
    ln.text=text.replace(/\s+/g," ").trim();
    ln.runs=collapseRuns(runs.map(r=>({text:r.text.replace(/\s+/g," "),style:r.style})));
    ln.font=dominantStyle(ln.runs);
    ln.x=ln.items[0].x;
    ln.right=ln.items[ln.items.length-1].x+ln.items[ln.items.length-1].w;
  }
  return lines.filter(l=>l.text.length);
}

/* ============================================================================
   STEP 2 — Contents-page detection (location-independent).
   We never assume the TOC is on a fixed page. Instead we score the front matter
   by the *shape* of a contents page: lines that end in a page number (usually
   after dot leaders), those numbers ascending, and an optional "Contents"
   header. Highest-scoring region wins.
   ============================================================================ */
const CHAP_RE=/^(chapter|chap\.?|part|book|prologue|epilogue|introduction|preface|foreword|appendix)\b/i;

function normTitle(s){
  return s.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g,"")  // drop diacritics
    .replace(/[^a-z0-9]+/g," ").trim();
}
function parseTocLines(lines){
  const entries=[];
  for(const l of lines){
    const m = l.text.match(/^(.{2,}?)[\s.]*\.{2,}\s*(\d{1,4})\s*$/)   // dot leaders
           || l.text.match(/^(.{2,}?)\s{2,}(\d{1,4})\s*$/);          // wide gap, no dots
    if(!m) continue;
    const title=m[1].replace(/[.\s]+$/,"").trim();
    const page=parseInt(m[2],10);
    if(title.length>=2 && title.length<=90 && page>0 && page<20000 && /[a-z]/i.test(title))
      entries.push({title,page,norm:normTitle(title)});
  }
  return entries;
}
function scorePage(lines){
  const entries=parseTocLines(lines);
  const nums=entries.map(e=>e.page);
  let asc=0; for(let i=1;i<nums.length;i++) if(nums[i]>=nums[i-1]) asc++;
  const word=lines.slice(0,4).some(l=>/^(table of\s+)?contents$/i.test(l.text.trim()));
  return {score: entries.length*2 + asc*3 + (word?10:0), entries};
}
function detectToc(pages){
  const win=Math.min(pages.length, 25);          // a TOC lives in the front matter
  const per=[]; let best={score:0,idx:-1};
  for(let i=0;i<win;i++){
    const r=scorePage(pages[i]); per.push(r);
    if(r.score>best.score) best={score:r.score,idx:i};
  }
  if(best.idx<0 || best.score<12 || per[best.idx].entries.length<3) return null;
  // a TOC may span 2–3 pages: absorb adjacent pages that also look like one
  let lo=best.idx, hi=best.idx;
  while(lo>0 && per[lo-1].entries.length>=3 && per[lo-1].score>=8) lo--;
  while(hi<win-1 && per[hi+1].entries.length>=3 && per[hi+1].score>=8) hi++;
  const tocPages=new Set(); let entries=[];
  for(let i=lo;i<=hi;i++){ tocPages.add(i); entries=entries.concat(per[i].entries); }
  const seen=new Set(), uniq=[];
  for(const e of entries){ if(!seen.has(e.norm)){ seen.add(e.norm); uniq.push(e); } }
  return {tocPages, entries:uniq};
}

/* ============================================================================
   STEP 3 — analyze lines into the document model (headings + paragraphs).
   Returns { blocks, tocMatched, tocTotal }.
   ============================================================================ */
function analyze(pages,opts,onProg,toc){
  onProg = onProg || (()=>{});
  const allLines=[];
  pages.forEach((lns,pi)=>lns.forEach(l=>allLines.push({...l,page:pi})));
  if(!allLines.length) return {blocks:[], tocMatched:0, tocTotal:0};

  const bodyH=median(allLines.map(l=>l.h));
  const bodyLeft=mode(allLines.map(l=>l.x));
  const bodyRight=Math.max(...allLines.map(l=>l.right));

  /* Typical line spacing (baseline-to-baseline), measured from the document
     itself. pdf.js reports glyph height inconsistently (often the cap/ascent
     height, ~0.7–0.8× the em), so a paragraph-gap threshold keyed to bodyH
     misfires and treats every line break as a new paragraph. The median of
     consecutive same-page line gaps is the real leading; paragraph breaks are
     the minority, so the median lands on the in-paragraph spacing. */
  const gaps=[];
  pages.forEach(lns=>{
    for(let i=1;i<lns.length;i++){
      const g=lns[i-1].y - lns[i].y;
      if(g>0.5) gaps.push(g);
    }
  });
  const bodyGap = gaps.length ? median(gaps) : bodyH*1.2;

  /* TOC-driven chapters: map each contents title to its real position in
     the body (an exact full-line match), rather than trusting page numbers
     — the printed→PDF offset is often inconsistent. First match wins. */
  const tocPending=new Map();   // norm -> original title text
  const tocPages = toc ? toc.tocPages : new Set();
  let tocMatched=0;
  if(toc && opts.headings) for(const e of toc.entries) if(!tocPending.has(e.norm)) tocPending.set(e.norm,e.title);

  /* --- find repeating running heads / feet to strip --- */
  const strip=new Set();
  if(opts.strip && pages.length>3){
    const freq=new Map();
    pages.forEach(lns=>{
      if(!lns.length) return;
      [lns[0],lns[lns.length-1]].forEach(l=>{
        const key=l.text.replace(/\d+/g,"#").trim();
        if(key.length>=2) freq.set(key,(freq.get(key)||0)+1);
      });
    });
    const thresh=Math.max(3,pages.length*0.25);
    for(const [k,c] of freq) if(c>=thresh) strip.add(k);
  }
  const isStripped=l=>{
    if(opts.strip){
      if(/^[ivxlcdm\d\s.\-—]+$/i.test(l.text) && l.text.replace(/[^a-z0-9]/gi,"").length<=4) {
        // bare page number / lone numeral
        if(l.text.replace(/[^0-9ivxlcdm]/gi,"").length===l.text.replace(/\s/g,"").length) return true;
      }
      if(strip.has(l.text.replace(/\d+/g,"#").trim())) return true;
    }
    return false;
  };

  /* The body's dominant style — usually "regular". A heading that is the same
     size as the body but set bolder is detectable because its line style
     differs from this. */
  const styleWeight=new Map();
  for(const l of allLines) styleWeight.set(l.font,(styleWeight.get(l.font)||0)+l.text.length);
  let bodyStyle="regular",bsc=-1;
  for(const [s,c] of styleWeight) if(c>bsc){bsc=c;bodyStyle=s;}

  const blocks=[];
  let lastBodyLine=null;
  /* Three independent accumulators: body paragraphs, footnotes, bibliography
     entries. Footnotes and references interleave with the body in reading order
     but must not be folded into body paragraphs. */
  const para={buf:"",runs:[]}, fn={buf:"",runs:[]}, bib={buf:"",runs:[]};

  /* Append a line's text + style runs to a buffer, mending hyphenation and
     keeping the runs in lockstep so inline emphasis survives the line-join. */
  const appendTo=(st,l)=>{
    const lineRuns=l.runs.map(r=>({text:r.text,style:r.style}));
    if(st.buf){
      if(opts.dehyphen && /[A-Za-zÀ-ÿ]-$/.test(st.buf) && /^[a-zà-ÿ]/.test(l.text)){
        st.buf=st.buf.replace(/-$/,"")+l.text;
        if(st.runs.length) st.runs[st.runs.length-1].text=st.runs[st.runs.length-1].text.replace(/-$/,"");
      } else {
        st.buf+=" "+l.text;
        if(st.runs.length) st.runs[st.runs.length-1].text+=" ";
      }
      for(const r of lineRuns) st.runs.push(r);
    } else { st.buf=l.text; st.runs=lineRuns; }
  };
  const flushAs=(st,kind)=>{
    if(st.buf.trim()) blocks.push({kind, text:st.buf.trim(), runs:collapseRuns(st.runs)});
    st.buf=""; st.runs=[];
  };
  const flush=()=>flushAs(para,"para");   // body paragraph

  /* Per-page content y-range, for spotting footnotes parked at the page foot. */
  const pageRange=new Map();
  for(const l of allLines){ const r=pageRange.get(l.page)||{min:Infinity,max:-Infinity};
    if(l.y<r.min)r.min=l.y; if(l.y>r.max)r.max=l.y; pageRange.set(l.page,r); }
  /* A footnote is set in smaller type than the body AND sits in the bottom band
     of the page. The size test alone would also catch mid-page figure notes; the
     position test alone would catch the last body line — together they're stable. */
  const isFootnote=(l)=>{
    if(!opts.headings) return false;
    const r=pageRange.get(l.page); if(!r) return false;
    const range=r.max-r.min; if(range<=0) return false;
    return l.h < bodyH*0.9 && l.y < r.min + range*0.28;
  };
  const FN_MARK=/^(\d{1,3}|[*†‡§¶])(?=\D)/;   // a footnote opens with a number or symbol
  const REF_HEAD=/^(references|bibliography|works cited|notes)$/i;
  let biblio=false, biblioLevel=0, refLeft=null;

  const headingLevel=(l)=>{
    if(!opts.headings) return 0;
    const isChap=CHAP_RE.test(l.text) && l.text.length<=70;
    const ratio=l.h/bodyH;
    const shortish=l.text.length>=2 && l.text.length<=80;
    const notSentence=!/[.,;:]$/.test(l.text);
    const bold=(l.font==="bold"||l.font==="bolditalic") && bodyStyle!=="bold" && bodyStyle!=="bolditalic";
    /* Section numbering ("1. Introduction", "2.1 AI Accelerates…", "3.2.1 …").
       Many papers set subsection titles in the plain body font at body size, so
       neither size nor weight reveals them — the number prefix does. Depth → level
       (0 dots = top section → h2, deeper → h3). Capped digits avoid matching
       years like "2024"; the required capitalised word avoids "100 million…". */
    const num=l.text.match(/^(\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+\p{Lu}/u);
    if(isChap) return 1;
    if(ratio>=1.55 && shortish && notSentence) return 1;
    if(ratio>=1.28 && shortish && notSentence) return 2;
    if(num && shortish && notSentence) return Math.min(3, 2 + (num[1].match(/\./g)||[]).length);
    if(ratio>=1.14 && shortish && notSentence && l.text.length<=60) return 3;
    /* Same-size section headings that are only set bolder than the body — the
       case the size-ratio rules miss. Require the whole line to be bold and not
       end like a sentence, so a paragraph with a bold lead-in word isn't a heading. */
    if(bold && shortish && notSentence && l.text.length<=70 && ratio>=0.9) return 2;
    return 0;
  };

  let processed=0;
  for(const l of allLines){
    processed++;
    if(processed%400===0) onProg(0.5+0.25*(processed/allLines.length),"Reconstructing text…");
    if(tocPages.has(l.page)) continue;        // don't pour the contents page into the body
    if(isStripped(l)) continue;

    /* Footnotes: small type at the page foot. Pull them out of the body flow so
       they can't corrupt paragraphs, and split them where a new note's marker
       (a number or symbol) begins. Emitted in document order. */
    if(isFootnote(l)){
      flush();
      if(FN_MARK.test(l.text) && fn.buf.trim()) flushAs(fn,"footnote");
      appendTo(fn,l);
      lastBodyLine=null;
      continue;
    }
    if(fn.buf.trim()) flushAs(fn,"footnote");   // left the footnote zone

    /* TOC match → authoritative chapter boundary (uses the contents' own casing) */
    if(tocPending.size){
      const key=normTitle(l.text);
      if(tocPending.has(key)){
        flush(); flushAs(bib,"biblio"); biblio=false;
        blocks.push({kind:"heading",level:1,text:tocPending.get(key),chapter:true});
        tocPending.delete(key); tocMatched++;
        lastBodyLine=null;
        continue;
      }
    }

    const hl=headingLevel(l);
    if(hl){
      flush(); flushAs(bib,"biblio");
      blocks.push({kind:"heading",level:hl,text:l.text});
      if(REF_HEAD.test(l.text.trim())){ biblio=true; biblioLevel=hl; refLeft=null; }
      else if(biblio && hl<=biblioLevel){ biblio=false; }
      lastBodyLine=null;
      continue;
    }

    /* Bibliography: hanging-indent entries — a new entry de-dents to the block's
       left margin, continuations sit indented under it. */
    if(biblio){
      if(refLeft===null) refLeft=l.x;
      if(l.x <= refLeft + bodyH*0.6) flushAs(bib,"biblio");   // back at the margin → new entry
      appendTo(bib,l);
      if(l.x<refLeft) refLeft=l.x;
      lastBodyLine=null;
      continue;
    }

    /* decide whether this body line starts a NEW paragraph */
    let newPara=false;
    if(!para.buf){
      newPara=true;
    } else if(lastBodyLine){
      /* A paragraph's first line is indented — but the indent is a step to the
         RIGHT of the line before it, measured locally, not against the global
         body margin. Keying only off bodyLeft shattered any block set at its
         own inset margin (abstracts, block quotes): every line there sits past
         bodyLeft and looked like a fresh paragraph. Requiring a rightward step
         from the previous line means inset blocks flow, and a de-dent back to a
         block's continuation margin is never mistaken for a new paragraph. */
      const indented = l.x > bodyLeft + bodyH*0.8 && l.x - lastBodyLine.x > bodyH*0.5;
      const sameApage = l.page===lastBodyLine.page;
      const vGap = sameApage ? (lastBodyLine.y - l.y) : 0;
      const bigGap = sameApage && vGap > bodyGap*1.5;
      const prevShortEnd = lastBodyLine.right < bodyRight - bodyH*3 && /[.!?»"”’)]$/.test(para.buf.trim());
      if(indented || bigGap || prevShortEnd) newPara=true;
    }

    if(newPara) flush();
    appendTo(para,l);
    lastBodyLine=l;
  }
  flush(); flushAs(fn,"footnote"); flushAs(bib,"biblio");
  return {blocks, tocMatched, tocTotal: toc ? tocPending.size + tocMatched : 0};
}

/* ============================================================================
   STEP 4 — slice the block stream into chapters.
   ============================================================================ */
function toChapters(blocks){
  if(!blocks.length) return [{title:"Text",blocks:[{kind:"para",text:"(No text could be extracted.)"}]}];

  const isHeading=(b,lvl)=> b.kind==="heading" && b.level===lvl;
  let chapters;

  // If a Contents page gave us authoritative boundaries, split on those.
  if(blocks.some(b=>b.chapter)){
    chapters=[]; let cur=null;
    for(const b of blocks){
      if(b.chapter){ cur={title:b.text,blocks:[b]}; chapters.push(cur); }
      else { if(!cur){ cur={title:"Front matter",blocks:[]}; chapters.push(cur); } cur.blocks.push(b); }
    }
  } else {
    /* Split at the shallowest heading level that actually recurs (≥2). A paper
       with a single title h1 shouldn't collapse into one file — its h2 sections
       become the files instead, and deeper headings nest under them in the nav. */
    let boundary=null;
    for(const lvl of [1,2,3]) if(blocks.filter(b=>isHeading(b,lvl)).length>=2){ boundary=lvl; break; }
    if(boundary===null) for(const lvl of [1,2,3]) if(blocks.some(b=>isHeading(b,lvl))){ boundary=lvl; break; }
    if(!boundary){ chapters=[{title:"Text",blocks}]; }
    else {
      chapters=[]; let cur=null;
      for(const b of blocks){
        if(isHeading(b,boundary)){ cur={title:b.text,blocks:[b]}; chapters.push(cur); }
        else { if(!cur){ cur={title:null,blocks:[]}; chapters.push(cur); } cur.blocks.push(b); }
      }
      // Name the leading pre-boundary section after its own title heading, if any.
      for(const ch of chapters) if(ch.title===null){
        const h=ch.blocks.find(b=>b.kind==="heading");
        ch.title = h ? h.text : "Opening";
      }
    }
  }

  // Stable ids on every heading, so nav anchors and chapter markup agree.
  let n=0;
  for(const ch of chapters) for(const b of ch.blocks) if(b.kind==="heading") b.id="h"+(++n);
  return chapters;
}

/* ============================================================================
   STEP 5 — serialize the IR into EPUB part strings.
   ============================================================================ */
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/* Render a block's inline runs, wrapping emphasis. Falls back to plain escaped
   text when no runs are present (e.g. font styles couldn't be resolved). */
function renderRuns(b){
  if(!b.runs || !b.runs.length) return esc(b.text);
  return b.runs.map(r=>{
    const t=esc(r.text);
    if(r.style==="bold") return `<strong>${t}</strong>`;
    if(r.style==="italic") return `<em>${t}</em>`;
    if(r.style==="bolditalic") return `<strong><em>${t}</em></strong>`;
    return t;
  }).join("");
}

function chapterXhtml(ch){
  const body=ch.blocks.map(b=>{
    if(b.kind==="heading")  return `<h${b.level}${b.id?` id="${b.id}"`:""}>${esc(b.text)}</h${b.level}>`;
    if(b.kind==="footnote") return `<p class="footnote">${renderRuns(b)}</p>`;
    if(b.kind==="biblio")   return `<p class="biblio">${renderRuns(b)}</p>`;
    return `<p>${renderRuns(b)}</p>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${esc(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/style.css"/></head>
<body>
${body}
</body></html>`;
}

const STYLE_CSS=`@namespace epub "http://www.idpf.org/2007/ops";
body{font-family:Georgia,"Times New Roman",serif;line-height:1.6;margin:5% 7%;text-align:justify;hyphens:auto;}
h1,h2,h3{font-family:Georgia,serif;line-height:1.25;font-weight:600;}
/* Only the chapter-level heading forces a page; sub-headings just get breathing
   room above and a tighter gap to the body that follows. */
h1{font-size:1.7em;text-align:center;margin:2.4em 0 1.1em;page-break-before:always;page-break-after:avoid;}
h2{font-size:1.32em;margin:1.8em 0 .55em;page-break-after:avoid;}
h3{font-size:1.1em;font-style:italic;margin:1.4em 0 .4em;page-break-after:avoid;}
p{margin:0;text-indent:1.25em;}
p:first-of-type,h1+p,h2+p,h3+p{text-indent:0;}
/* footnotes: smaller, set off from the body, never first-line indented */
p.footnote{font-size:.82em;line-height:1.4;text-indent:0;margin:.15em 0;color:#333;}
p.footnote:first-of-type,p:not(.footnote)+p.footnote{margin-top:.8em;border-top:1px solid #bbb;padding-top:.5em;}
/* bibliography: hanging indent, no justification (long URLs/titles break badly) */
p.biblio{text-indent:-1.4em;margin:0 0 .4em 1.4em;text-align:left;}
`;

/* Full-bleed cover page. `cover` = { href, mediaType } where href is the image
   path relative to OEBPS (e.g. "images/cover.jpg"). */
function coverXhtml(cover){
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>Cover</title>
<style>html,body{margin:0;padding:0;height:100%;}
.cover{margin:0;padding:0;text-align:center;page-break-after:always;}
.cover img{max-width:100%;max-height:100vh;}</style></head>
<body epub:type="cover">
<section class="cover"><img src="../${cover.href}" alt="Cover"/></section>
</body></html>`;
}

function buildOpf(meta,chapters,uid,modified,cover){
  const manifest=[
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="styles/style.css" media-type="text/css"/>`
  ];
  const spine=[];
  if(cover){
    manifest.push(`<item id="cover-image" href="${cover.href}" media-type="${cover.mediaType}" properties="cover-image"/>`);
    manifest.push(`<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="cover"/>`);
  }
  chapters.forEach((c,i)=>{
    manifest.push(`<item id="c${i+1}" href="text/chap${i+1}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i+1}"/>`);
  });
  // EPUB 2 reading systems (incl. older iOS Books) look for this legacy cover meta.
  const coverMeta = cover ? `\n    <meta name="cover" content="cover-image"/>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>
    <dc:title>${esc(meta.title)}</dc:title>
    <dc:creator>${esc(meta.author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>${coverMeta}
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${spine.join("\n    ")}
  </spine>
</package>`;
}

/* Build a nested navigation tree from chapters and the headings inside them.
   Each chapter is a top node (linking to its file); headings deeper than the
   chapter's own title level nest beneath it by level. */
function navTree(chapters){
  const roots=[];
  chapters.forEach((ch,ci)=>{
    const href=`text/chap${ci+1}.xhtml`;
    const firstH=ch.blocks.find(b=>b.kind==="heading");
    const baseLevel=firstH ? firstH.level : 0;
    const root={title:ch.title, href, children:[]};
    roots.push(root);
    const stack=[{level:baseLevel, node:root}];
    for(const b of ch.blocks){
      if(b.kind==="heading" && b.id && b.level>baseLevel){
        const child={title:b.text, href:`${href}#${b.id}`, children:[]};
        while(stack.length>1 && stack[stack.length-1].level>=b.level) stack.pop();
        stack[stack.length-1].node.children.push(child);
        stack.push({level:b.level, node:child});
      }
    }
  });
  return roots;
}

function buildNav(chapters,cover){
  const render=(nodes,pad)=> nodes.map(n=>{
    const sub=n.children.length ? `\n${pad}  <ol>\n${render(n.children,pad+"    ")}\n${pad}  </ol>\n${pad}` : "";
    return `${pad}<li><a href="${n.href}">${esc(n.title)}</a>${sub}</li>`;
  }).join("\n");
  /* Landmarks tell the reader where the book proper begins (and where the cover
     is), so it opens to content rather than a blank/preview page. */
  const landmarks=`<nav epub:type="landmarks" id="landmarks" hidden="hidden"><h2>Guide</h2>
    <ol>
${cover?`      <li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>\n`:""}      <li><a epub:type="bodymatter" href="text/chap1.xhtml">Begin Reading</a></li>
    </ol>
  </nav>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>Contents</h1>
    <ol>
${render(navTree(chapters),"      ")}
    </ol>
  </nav>
  ${landmarks}
</body></html>`;
}

function buildNcx(chapters,uid,title){
  let order=0;
  const render=(nodes,pad)=> nodes.map(n=>{
    order++;
    const kids=n.children.length ? `\n${render(n.children,pad+"  ")}\n${pad}` : "";
    return `${pad}<navPoint id="np${order}" playOrder="${order}">` +
           `<navLabel><text>${esc(n.title)}</text></navLabel>` +
           `<content src="${n.href}"/>${kids}</navPoint>`;
  }).join("\n");
  const points=render(navTree(chapters),"    ");
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${uid}"/></head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

return { fontStyle, buildLines, detectToc, analyze, toChapters,
         esc, chapterXhtml, coverXhtml, STYLE_CSS, buildOpf, buildNav, buildNcx };
});
