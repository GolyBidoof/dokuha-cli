/**
 * Parse the `ttx` document returned by `sbcGetCntnt.php` into a page list.
 *
 * `ttx` is an XHTML-ish document whose `<t-img>` elements each describe one
 * page image. It contains two variants of the whole book, selected by media
 * query:
 *
 *   <t-case screen.portrait="screen.portrait"> ...portrait pages... </t-case>
 *   ...landscape pages...
 *
 * The viewer's `timgsLandscape` getter deletes the `t-case` blocks (and
 * `timgsPortrait` deletes the `t-nocase` blocks), then runs the same tag
 * scanner over what is left. The speed reader runs in landscape, so the page
 * list is the landscape half. Getting this wrong silently doubles the page
 * count, so both the deletion and the scan are mirrored here.
 *
 * Per page the scanner keeps:
 *   src         path of the image, also the scramble-table selector
 *   orgwidth    declared original width
 *   orgheight   declared original height
 *   pageSpread  centre / left / right, from the `a` attribute
 *   id          e.g. L0042
 *   usemap      image-map name, if the page links anywhere
 */

/** Viewer's `PageSpread`. */
export const PageSpread = { Center: 0, Left: 1, Right: 2 };

const TAG_RE = /<(t-pb|t-img|img|a)(\s+([^>]*)|)>/gi;

/** Attribute scanner, mirroring the viewer's `getTagAttributes`. */
function attributes(text) {
  const out = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}

/**
 * Scan one tag stream for images. `<t-pb>` starts a new page break: anchors
 * seen since the last break are attached to the next image as `anchors`.
 */
function scanImages(markup) {
  const pages = [];
  let anchors = [];
  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(markup)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = attributes(match[2] || '');
    if (tag === 't-pb') {
      anchors = [];
      continue;
    }
    if (tag === 't-img' || tag === 'img') {
      const page = {
        id: attrs.id || '',
        src: attrs.src || '',
        orgwidth: parseInt(attrs.orgwidth, 10) || 0,
        orgheight: parseInt(attrs.orgheight, 10) || 0,
        pageSpread: PageSpread.Center,
        anchors: anchors.slice(),
        usemap: attrs.usemap || '',
        preview: attrs.preview === 'true',
      };
      if (attrs.a !== undefined) {
        const a = parseInt(attrs.a, 10);
        // 0-9 centre, 10-19 left, 20-29 right; anything else is centre.
        if (a >= 0 && a < 30) {
          page.pageSpread = [PageSpread.Center, PageSpread.Left, PageSpread.Right][
            Math.floor(a / 10)
          ];
        }
      }
      if (page.src && page.orgwidth && page.orgheight) pages.push(page);
      anchors = [];
      continue;
    }
    if (tag === 'a' && attrs.name) anchors.push(attrs.name);
  }
  return pages;
}

/**
 * Extract the landscape page list, mirroring `Reader.timgsLandscape`.
 *
 * The regexes are the viewer's, including the `i`/`m` flags: a `t-case` block
 * spans multiple lines, so the dot-all behaviour of `[\s\S]` is used here where
 * the viewer relies on the `m` flag plus `.*?`.
 */
export function parsePageList(ttx) {
  const landscape = String(ttx).replace(
    /<t-case\s+[^>]*screen\.portrait[^>]*>([\s\S]*?)<\/t-case>/gi,
    '',
  );
  return scanImages(landscape);
}

/** Extract the portrait page list (`Reader.timgsPortrait`), for completeness. */
export function parsePageListPortrait(ttx) {
  const portrait = String(ttx).replace(
    /<t-nocase\s+[^>]*screen\.portrait[^>]*>[\s\S]*?<\/t-nocase>/gi,
    '',
  );
  return scanImages(portrait);
}

/** Read `<t-time>` attributes from the document head. */
export function parseBookMeta(ttx) {
  const out = {};
  const time = /<t-time\b([^>]*)>/i.exec(String(ttx));
  if (time) {
    const attrs = attributes(time[1]);
    out.direction = attrs.pagedirection || '';
    out.author = attrs.author || '';
    out.publisher = attrs.publisher || '';
    out.doublePage = attrs.dan || '';
    out.hashiraLevel = attrs.hashiralevel || '';
  }
  const title = /<title>([\s\S]*?)<\/title>/i.exec(String(ttx));
  if (title) out.title = title[1].trim();
  return out;
}
