/* Runs `node --check` over every backend and frontend JS file. */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const roots = ['backend', 'scripts', path.join('frontend', 'assets', 'js')];
const files = [];

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`ok   ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${e.stderr}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
