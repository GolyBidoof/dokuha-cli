/**
 * Cross-checks the page-list parser against the live sbcGetCntnt response.
 * Run: node test/pagelist.test.mjs
 */
import fs from 'node:fs';
import { parsePageList, parsePageListPortrait, parseBookMeta } from '../src/pagelist.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ctx = JSON.parse(fs.readFileSync('/tmp/e2e_ctx.json', 'utf8'));
const res = await fetch(
  `${ctx.srv}/sbcGetCntnt.php?cid=${ctx.cid}&p=${ctx.p}&vm=${ctx.vm}&dmytime=${ctx.date}&u0=1`,
  {
    headers: {
      'User-Agent': UA,
      Referer: `https://www.cmoa.jp/bib/speedreader/?cid=${ctx.cid}&u0=1`,
    },
  },
);
const ttx = (await res.json()).ttx;
const pages = parsePageList(ttx);
const checks = [];
const check = (name, got, want) => checks.push({ name, got, want, ok: got === want });

check('landscape page count', pages.length, 244);
check('portrait page count', parsePageListPortrait(ttx).length, 244);
check('both halves cover all t-img', pages.length + parsePageListPortrait(ttx).length, 488);
check('first id', pages[0].id, 'L0000');
check('last id', pages.at(-1).id, 'L0243');
check('unique ids', new Set(pages.map((p) => p.id)).size, 244);
check('all 1350x1920', pages.every((p) => p.orgwidth === 1350 && p.orgheight === 1920), true);
check('srcs match viewer order', JSON.stringify(pages.map((p) => p.src)), JSON.stringify(ctx.srcs));
check('title', parseBookMeta(ttx).title, 'スーパーの裏でヤニ吸うふたり 1巻');
check('direction', parseBookMeta(ttx).direction, 'left');
check('spread: single centre page', pages.filter((p) => p.pageSpread === 0).length, 1);
check('has usemaps', pages.filter((p) => p.usemap).length > 0, true);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(c.got)}${c.ok ? '' : ` (want ${JSON.stringify(c.want)})`}`);
}
console.log(bad === 0 ? '\nall page-list checks passed' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
