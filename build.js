#!/usr/bin/env node
/* ============================================================
   RESONANCE — build.js
   Inlines every src module + the analyzer (as text, for the
   Worker Blob) into a single self-contained index.html.
   No network, no dependencies — works from plain file://.
   Usage: node build.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* load order matters: each module attaches to window.RS */
const SCRIPTS = [
  'src/utils.js',
  'src/demosynth.js',
  'src/generator.js',
  'src/clock.js',
  'src/scoring.js',
  'src/audio.js',
  'src/entities.js',
  'src/world.js',
  'src/engine.js',
  'src/ui.js',
  'src/main.js',
];

const analyzer = read('src/analyzer.js');
if (/<\/script/i.test(analyzer)) throw new Error('analyzer.js must not contain </script>');

let html = read('template.html');
if (!html.includes('__ANALYZER__') || !html.includes('__SCRIPTS__')) {
  throw new Error('template.html is missing placeholders');
}

const scriptTags = SCRIPTS.map((f) => {
  const code = read(f);
  if (/<\/script/i.test(code)) throw new Error(f + ' must not contain </script>');
  return '<script>\n/* ==== ' + f + ' ==== */\n' + code + '\n</script>';
}).join('\n');

/* function replacements — literal $ in code must not be interpreted */
html = html.replace('__ANALYZER__', () => analyzer);
html = html.replace('__SCRIPTS__', () => scriptTags);

const out = path.join(ROOT, 'index.html');
fs.writeFileSync(out, html);

/* report */
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('built index.html (' + kb(fs.statSync(out).size) + ') from ' + SCRIPTS.length + ' modules + analyzer (' + kb(analyzer.length) + ')');
const left = html.match(/__[A-Z]+__/g);
if (left) { console.warn('WARNING: unresolved placeholders:', left); process.exit(1); }
console.log('OK — open index.html directly in a browser (works from file://)');
