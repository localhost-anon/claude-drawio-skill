#!/usr/bin/env node
// Turn a .drawio into a PowerPoint deck — one slide per page.
//
// Node port of drawio2pptx.py. The Python original used python-pptx (which
// mutates a bundled default .pptx template); this port has zero deps, so it
// hand-writes a minimal-but-valid OOXML .pptx package instead — same CLI,
// same slide layout math (16:9, 0.5in margin, centred+scaled image, optional
// title), but the underlying XML parts are our own minimal template rather
// than python-pptx's. The zip container is hand-written (STORED, no
// compression) since Node has no zip-writer in stdlib.
//
// Usage: drawio2pptx.mjs <file.drawio> [-o out.pptx] [--scale N]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";
import { parse as parseXml, findAll } from "./lib/xml.mjs";

// --------------------------------------------------------------------------
// Minimal STORED-only ZIP writer (no compression — deflate isn't required
// by the OOXML spec, and skipping it keeps this dependency-free and simple).
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  // Node's zlib doesn't expose crc32 directly (no zlib.crc32 export as of
  // Node 20/22), so compute it by hand with the standard IEEE 802.3 table.
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date/time encoding (used by both local file header and central dir).
function dosDateTime(date = new Date()) {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.central = [];
    this.offset = 0;
  }

  add(name, data) {
    const nameBuf = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const crc = crc32(content);
    const { dosTime, dosDate } = dosDateTime();
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 filenames
    local.writeUInt16LE(0, 8); // compression method: 0 = STORED
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    this.chunks.push(local, nameBuf, content);
    this.offset += local.length + nameBuf.length + content.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localOffset, 42); // relative offset of local header

    this.central.push(Buffer.concat([centralHeader, nameBuf]));
  }

  toBuffer() {
    const centralStart = this.offset;
    const centralBuf = Buffer.concat(this.central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with central dir
    eocd.writeUInt16LE(this.central.length, 8); // entries on this disk
    eocd.writeUInt16LE(this.central.length, 10); // total entries
    eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
    eocd.writeUInt32LE(centralStart, 16); // central dir offset
    eocd.writeUInt16LE(0, 20); // comment length
    return Buffer.concat([...this.chunks, centralBuf, eocd]);
  }
}

// --------------------------------------------------------------------------
// .drawio / PNG helpers
// --------------------------------------------------------------------------

function pageNames(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (exc) {
    die(`cannot parse ${filePath}: ${exc.message}`);
  }
  let root;
  try {
    root = parseXml(text);
  } catch (exc) {
    die(`cannot parse ${filePath}: ${exc.message}`);
  }
  const diagrams = findAll(root, "diagram");
  return diagrams.length ? diagrams.map((d) => d.attrs.name ?? null) : [null];
}

function pngSize(filePath) {
  const fd = fs.openSync(filePath, "r");
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

function exportPage(drawioFile, index, outPng, scale) {
  try {
    execFileSync(
      "drawio",
      ["-x", "-f", "png", "--page-index", String(index), "-s", String(scale), "-o", outPng, drawioFile],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
  } catch {
    return false;
  }
  return fs.existsSync(outPng);
}

// --------------------------------------------------------------------------
// Minimal OOXML PresentationML parts
// --------------------------------------------------------------------------

const SLIDE_W = 12192000; // 13.333in — 16:9
const SLIDE_H = 6858000; // 7.5in
const MARGIN = 457200; // 0.5in
const TITLE_H = 500000;

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentTypesXml(slideCount) {
  const overrides = [];
  for (let i = 1; i <= slideCount; i++) {
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    overrides.join("") +
    "</Types>"
  );
}

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  "</Relationships>";

function presentationXml(slideCount) {
  const sldIdLst = [];
  for (let i = 0; i < slideCount; i++) {
    sldIdLst.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIdLst.join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>"
  );
}

function presentationRelsXml(slideCount) {
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
  ];
  for (let i = 0; i < slideCount; i++) {
    rels.push(
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    );
  }
  rels.push(
    `<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join("") +
    "</Relationships>"
  );
}

const THEME_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="drawio2pptx">' +
  "<a:themeElements>" +
  '<a:clrScheme name="drawio2pptx">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F497D"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="C0504D"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="F79646"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0000FF"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="800080"/></a:folHlink>' +
  "</a:clrScheme>" +
  '<a:fontScheme name="drawio2pptx">' +
  '<a:majorFont><a:latin typeface="Calibri"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>' +
  "</a:fontScheme>" +
  '<a:fmtScheme name="drawio2pptx">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  "</a:fmtScheme>" +
  "</a:themeElements>" +
  "</a:theme>";

const SLIDE_MASTER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  "</p:spTree></p:cSld>" +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  "</p:sldMaster>";

const SLIDE_MASTER_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  "</Relationships>";

const SLIDE_LAYOUT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">' +
  '<p:cSld name="Blank"><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  "</p:spTree></p:cSld>" +
  "</p:sldLayout>";

const SLIDE_LAYOUT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  "</Relationships>";

// One slide: optional title textbox (shape id 2) + a picture (shape/id 3).
function slideXml({ title, imgLeft, imgTop, imgW, imgH, marginLeft, titleTop, titleW, titleH }) {
  let shapes = "";
  let nextId = 2;
  if (title) {
    shapes +=
      `<p:sp><p:nvSpPr><p:cNvPr id="${nextId}" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${marginLeft}" y="${titleTop}"/><a:ext cx="${titleW}" cy="${titleH}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>' +
      `<a:p><a:r><a:rPr lang="en-US" sz="2000" b="1" dirty="0"/><a:t>${xmlEsc(title)}</a:t></a:r></a:p>` +
      "</p:txBody></p:sp>";
    nextId++;
  }
  shapes +=
    `<p:pic><p:nvPicPr><p:cNvPr id="${nextId}" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr><a:xfrm><a:off x="${imgLeft}" y="${imgTop}"/><a:ext cx="${imgW}" cy="${imgH}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes +
    "</p:spTree></p:cSld>" +
    "</p:sld>"
  );
}

function slideRelsXml(imgName) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imgName}"/>` +
    "</Relationships>"
  );
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  const a = parseArgs(
    {
      name: "drawio2pptx",
      usage: "Usage: drawio2pptx.mjs <file.drawio> [-o out.pptx] [--scale N]",
      flags: {
        output: { short: "-o", takesValue: true },
        scale: { takesValue: true, type: "float", default: 2.0 },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <file.drawio>");
  const file = a._[0];
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    die(`${file} not found`);
  }

  const names = pageNames(file);
  const out = a.output || path.join(path.dirname(file), path.basename(file).replace(/\.[^.]*$/, "") + ".pptx");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawio2pptx-"));
  const slides = [];
  try {
    names.forEach((name, idx0) => {
      const i = idx0 + 1; // draw.io --page-index is 1-based
      const png = path.join(tmp, `page${i}.png`);
      if (!exportPage(file, i, png, a.scale)) {
        process.stderr.write(`warning: page ${i} export failed — skipped\n`);
        return;
      }
      slides.push({ name, png, index: slides.length + 1 });
    });
  } finally {
    // cleanup happens after PNGs are read into the zip, below
  }

  if (!slides.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die("no pages exported (is the draw.io CLI installed?)");
  }

  const zip = new ZipWriter();
  zip.add("[Content_Types].xml", contentTypesXml(slides.length));
  zip.add("_rels/.rels", ROOT_RELS);
  zip.add("ppt/presentation.xml", presentationXml(slides.length));
  zip.add("ppt/_rels/presentation.xml.rels", presentationRelsXml(slides.length));
  zip.add("ppt/theme/theme1.xml", THEME_XML);
  zip.add("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER_XML);
  zip.add("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS_XML);
  zip.add("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT_XML);
  zip.add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS_XML);

  for (const slide of slides) {
    const margin = MARGIN;
    let topPad = margin;
    let titleTop = 0, titleW = 0, titleH = 0;
    const hasTitle = !!slide.name;
    if (hasTitle) {
      titleTop = 180000;
      titleW = SLIDE_W - 2 * margin;
      titleH = TITLE_H;
      topPad = 180000 + TITLE_H;
    }
    const cw = SLIDE_W - 2 * margin;
    const ch = SLIDE_H - topPad - margin;
    const [pw, ph] = pngSize(slide.png);
    const scale = Math.min(cw / pw, ch / ph);
    const iw = Math.round(pw * scale);
    const ih = Math.round(ph * scale);
    const left = Math.round((SLIDE_W - iw) / 2);
    const top = Math.round(topPad + (ch - ih) / 2);

    const imgName = `image${slide.index}.png`;
    zip.add(`ppt/media/${imgName}`, fs.readFileSync(slide.png));
    zip.add(
      `ppt/slides/slide${slide.index}.xml`,
      slideXml({
        title: slide.name,
        imgLeft: left,
        imgTop: top,
        imgW: iw,
        imgH: ih,
        marginLeft: margin,
        titleTop,
        titleW,
        titleH,
      })
    );
    zip.add(`ppt/slides/_rels/slide${slide.index}.xml.rels`, slideRelsXml(imgName));
  }

  fs.writeFileSync(out, zip.toBuffer());
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stderr.write(`wrote ${out} (${slides.length} slide${slides.length !== 1 ? "s" : ""})\n`);
}

function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main();
}
