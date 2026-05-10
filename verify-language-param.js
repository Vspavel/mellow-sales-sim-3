#!/usr/bin/env node
// Quick verification that language:ru is in the batch runner code
// Does NOT require server running

import { readFileSync } from 'fs';

const files = [
  { path: 'run_test_10x20.js', line: 37, pattern: /language:\s*['"]ru['"]/ },
  { path: 'run_batch_30x6.js', line: 36, pattern: /language:\s*['"]ru['"]/ },
];

let allPass = true;

console.log('\n=== MEL-1851 Code Verification ===\n');

for (const { path, line, pattern } of files) {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const lineContent = lines[line - 1] || '';
  const matches = pattern.test(lineContent);

  const status = matches ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} ${path}:${line}`);
  console.log(`    ${lineContent.trim()}`);

  if (!matches) {
    allPass = false;
    console.log(`    Expected: language: 'ru' in POST /api/sessions call`);
  }
  console.log();
}

console.log(`\nResult: ${allPass ? '✅ All checks passed' : '❌ Some checks failed'}`);
console.log('Next: Start server and run smoke test with run_test_10x20.js\n');

process.exit(allPass ? 0 : 1);
