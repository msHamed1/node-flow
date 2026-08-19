import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const retiredScope = ['@node', '-flow'].join('');
const retiredScopeBytes = Buffer.from(retiredScope);
const ignoredDirectories = new Set(['.git', 'node_modules']);
const matches = [];

const scan = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) scan(path);
      continue;
    }
    if (entry.isFile() && readFileSync(path).includes(retiredScopeBytes)) {
      matches.push(path.slice(root.length + 1));
    }
  }
};

scan(root);

if (matches.length > 0) {
  console.error('Retired npm scope references remain:');
  for (const match of matches) console.error(`- ${match}`);
  process.exit(1);
}

console.log('No retired npm scope references remain outside dependency directories.');
