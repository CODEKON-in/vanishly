/**
 * Cheap but effective front-end audit:
 *  - every getElementById(...) in the JS must exist in the HTML it runs on
 *  - no inline style="" attributes (the CSP has no 'unsafe-inline' for styles)
 *  - no external script/style/font origins (CSP is 'self' only)
 *  - every CSS class used in markup is defined somewhere in the stylesheet
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFile(join(root, p), 'utf8');

const pairs = [
  ['public/index.html', 'public/js/app.js'],
  ['public/viewer.html', 'public/js/viewer.js'],
  ['public/pricing.html', 'public/js/pricing.js'],
  ['public/account.html', 'public/js/account.js'],
];

const problems = [];
const css = await read('public/css/style.css');
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

for (const [htmlPath, jsPath] of pairs) {
  const html = await read(htmlPath);
  const js = await read(jsPath);

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
    if (!ids.has(m[1])) problems.push(`${jsPath}: $('${m[1]}') has no matching id in ${htmlPath}`);
  }

  for (const m of html.matchAll(/\bfor="([^"]+)"/g)) {
    if (!ids.has(m[1])) problems.push(`${htmlPath}: <label for="${m[1]}"> points at no element`);
  }
  for (const attr of ['aria-labelledby', 'aria-describedby']) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      for (const ref of m[1].split(/\s+/)) {
        if (!ids.has(ref)) problems.push(`${htmlPath}: ${attr}="${ref}" points at no element`);
      }
    }
  }

  if (/\sstyle="/.test(html)) problems.push(`${htmlPath}: has an inline style attribute, which the CSP blocks`);
  // Only resource loads matter here. A plain <a href="https://..."> is
  // navigation, which no CSP directive in use blocks.
  for (const m of html.matchAll(/<(link|script|img|iframe|source|video|audio|embed|object)\b[^>]*?\b(?:src|href)="(?:https?:)?\/\/[^"]+"/gi)) {
    problems.push(`${htmlPath}: external resource in <${m[1]}> is blocked by the CSP`);
  }

  for (const m of html.matchAll(/\bclass="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      if (!cssClasses.has(cls)) problems.push(`${htmlPath}: class "${cls}" is not defined in style.css`);
    }
  }
}

// Classes the JS adds at runtime must exist too.
for (const jsPath of ['public/js/app.js', 'public/js/viewer.js', 'public/js/pricing.js', 'public/js/account.js']) {
  const js = await read(jsPath);
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) {
    if (!cssClasses.has(m[1])) problems.push(`${jsPath}: runtime class "${m[1]}" is not defined in style.css`);
  }
  for (const m of js.matchAll(/className = `?([a-z][\w- ]*)/g)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      if (!cssClasses.has(cls)) problems.push(`${jsPath}: className "${cls}" is not defined in style.css`);
    }
  }
}

if (problems.length) {
  console.log(`DOM audit found ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('DOM audit clean: ids, labels, aria refs, classes and CSP origins all check out.');
