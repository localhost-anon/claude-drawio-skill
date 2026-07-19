// Minimal hand-rolled XML parser/serializer mirroring the subset of
// xml.etree.ElementTree used by the Python drawio-skill scripts.
// No namespaces, no CDATA, no DOCTYPE — draw.io files don't use them.

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

function node(tag) {
  return { tag, attrs: {}, children: [], text: "" };
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s="]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

/**
 * Parse an XML string into a tree of {tag, attrs, children, text}.
 * `text` collects the node's own direct text content (concatenated,
 * entity-decoded); whitespace-only text nodes are dropped.
 */
export function parse(text) {
  let i = 0;
  const n = text.length;

  function skipProlog() {
    // XML declaration
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i);
      i = end === -1 ? n : end + 2;
    }
  }

  function skipMisc() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      break;
    }
  }

  function parseElement() {
    // assumes text[i] === '<'
    i++; // consume '<'
    const start = i;
    while (i < n && !/[\s/>]/.test(text[i])) i++;
    const tag = text.slice(start, i);
    const attrStart = i;
    // find end of tag, respecting quoted attribute values
    let selfClose = false;
    while (i < n) {
      if (text[i] === '"') {
        i++;
        while (i < n && text[i] !== '"') i++;
        i++;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === ">") {
        selfClose = true;
        break;
      }
      if (text[i] === ">") break;
      i++;
    }
    const attrsStr = text.slice(attrStart, i);
    const el = node(tag);
    el.attrs = parseAttrs(attrsStr);

    if (selfClose) {
      i += 2; // consume '/>'
      return el;
    }
    i += 1; // consume '>'

    let textBuf = "";
    for (;;) {
      if (i >= n) break;
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (text.startsWith("</", i)) {
        const end = text.indexOf(">", i);
        i = end === -1 ? n : end + 1;
        break;
      }
      if (text[i] === "<") {
        const child = parseElement();
        el.children.push(child);
        continue;
      }
      const start2 = i;
      while (i < n && text[i] !== "<") i++;
      textBuf += text.slice(start2, i);
    }
    if (textBuf.trim() !== "") {
      el.text = decodeEntities(textBuf);
    }
    return el;
  }

  skipProlog();
  skipMisc();
  const root = parseElement();
  return root;
}

/**
 * Serialize a node tree back to an XML string.
 * @param {object} node
 * @param {{indent?: number|string}} [opts]
 */
export function serialize(root, opts = {}) {
  const indent = opts.indent;
  const indentStr =
    typeof indent === "number" ? " ".repeat(indent) : typeof indent === "string" ? indent : null;

  function attrsToStr(attrs) {
    return Object.keys(attrs)
      .map((k) => ` ${k}="${escAttr(attrs[k])}"`)
      .join("");
  }

  function render(n, depth) {
    const pad = indentStr ? indentStr.repeat(depth) : "";
    const nl = indentStr ? "\n" : "";
    const openTag = `<${n.tag}${attrsToStr(n.attrs)}`;
    const hasChildren = n.children.length > 0;
    const hasText = n.text && n.text.length > 0;

    if (!hasChildren && !hasText) {
      return `${pad}${openTag}/>`;
    }

    if (!hasChildren && hasText) {
      return `${pad}${openTag}>${esc(n.text)}</${n.tag}>`;
    }

    const childrenStr = n.children.map((c) => render(c, depth + 1)).join(nl);
    const textPart = hasText ? esc(n.text) : "";
    return `${pad}${openTag}>${textPart}${nl}${childrenStr}${nl}${pad}</${n.tag}>`;
  }

  return render(root, 0);
}

/** First direct child with the given tag, or null. */
export function find(n, tag) {
  for (const c of n.children) {
    if (c.tag === tag) return c;
  }
  return null;
}

/** All descendants (any depth) with the given tag, in document order. */
export function findAll(n, tag) {
  const out = [];
  function walk(node) {
    for (const c of node.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  }
  walk(n);
  return out;
}
