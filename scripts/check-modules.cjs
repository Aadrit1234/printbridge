/* Syntax-check the ES modules the browser loads.
 *
 *   node scripts/check-modules.cjs
 *
 * The main check script runs `node --check` over every source file, but that
 * parser only understands CommonJS — a file with `import`/`export` in it fails
 * the moment Node reads it, so those files were quietly left out of the check.
 * They are also the files with no build step, no type checker and no bundler:
 * a typo in them is found by a customer, not by us.
 *
 * `node --check` does parse ES modules when the file ends in .mjs, so each
 * module is copied to a temporary .mjs and checked there. Nothing is executed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** Every module the app or the sites load as `type="module"`. */
function collect() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'public', 'app'));
  walk(path.join(ROOT, 'desktop', 'renderer'));
  return out.sort();
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-modules-'));
const files = collect();
let failed = 0;

for (const file of files) {
  const copy = path.join(scratch, `${path.basename(file, '.js')}.mjs`);
  fs.writeFileSync(copy, fs.readFileSync(file, 'utf8'));
  const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    const message = String(result.stderr || '').split('\n').find(line => /SyntaxError|Error:/.test(line)) || 'did not parse';
    console.error(`  ✗ ${path.relative(ROOT, file)}\n    ${message.trim()}`);
  }
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`  front-end modules   ${files.length - failed}/${files.length} parsed`);
if (failed) {
  console.error(`\n  ${failed} module(s) have syntax errors\n`);
  process.exit(1);
}
