const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..');
const servicesDir = path.join(baseDir, 'services');
const routesDir = path.join(baseDir, 'routes');
const indexFile = path.join(baseDir, 'index.cjs');

const files = [];

if (fs.existsSync(servicesDir)) {
  fs.readdirSync(servicesDir).forEach(f => {
    if (f.endsWith('.cjs')) files.push(path.join(servicesDir, f));
  });
}

if (fs.existsSync(routesDir)) {
  fs.readdirSync(routesDir).forEach(f => {
    if (f.endsWith('.cjs')) files.push(path.join(routesDir, f));
  });
}

if (fs.existsSync(indexFile)) {
  files.push(indexFile);
}

const writers = [];

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  // Pattern 1: saveLedgerEntry or _saveLedgerEntry calls (exclude definitions)
  lines.forEach((line, i) => {
    const stripped = line.replace(/\/\/.*$/, '').trim();
    // Match calls like: await this.saveLedgerEntry, saveLedgerEntry(
    if (stripped.match(/(await\s+)?(this\.)?saveLedgerEntry\s*\(/) &&
        !stripped.match(/^(async\s+)?saveLedgerEntry\s*\(|^const\s+saveLedgerEntry|function\s+saveLedgerEntry|saveLedgerEntry\s*=\s*async/)) {
      writers.push({ file: path.basename(file), line: i + 1, pattern: 'saveLedgerEntry', code: line.trim().substring(0, 120) });
    }
    if (stripped.match(/(await\s+)?this\._saveLedgerEntry\s*\(/) &&
        !stripped.match(/^(async\s+)?_saveLedgerEntry\s*\(|^const\s+_saveLedgerEntry/)) {
      writers.push({ file: path.basename(file), line: i + 1, pattern: '_saveLedgerEntry', code: line.trim().substring(0, 120) });
    }
  });

  // Pattern 2: Direct INSERT INTO ledger_entries
  lines.forEach((line, i) => {
    if (line.match(/INSERT\s+INTO\s+ledger_entries/i)) {
      writers.push({ file: path.basename(file), line: i + 1, pattern: 'INSERT INTO ledger_entries', code: line.trim().substring(0, 120) });
    }
  });

  // Pattern 3: repo.upsert with ledger_entries
  lines.forEach((line, i) => {
    const stripped = line.replace(/\/\/.*$/, '').trim();
    if (stripped.match(/upsert\(['"]ledger_entries['"]/)) {
      writers.push({ file: path.basename(file), line: i + 1, pattern: 'repo.upsert(ledger_entries)', code: line.trim().substring(0, 120) });
    }
  });
});

console.log('=== Ledger Writer Audit ===\n');
console.log('Total writers found:', writers.length);
console.log('');

const byFile = {};
writers.forEach(w => {
  if (!byFile[w.file]) byFile[w.file] = [];
  byFile[w.file].push(w);
});

Object.keys(byFile).sort().forEach(file => {
  console.log(`\n${file}: ${byFile[file].length} writers`);
  byFile[file].forEach(w => {
    console.log(`  Line ${w.line} [${w.pattern}]: ${w.code}`);
  });
});

// Now check for account_id resolution safety
console.log('\n\n=== Account Resolution Safety Check ===');
let unsafeCount = 0;
let silentFallbackCount = 0;

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, i) => {
    // Check for hardcoded old 4-digit codes as fallbacks
    if (line.match(/return\s+['"](11101|40000|50000|1000|1100|1200|2000)['"]/)) {
      console.log(`  SILENT FALLBACK [${path.basename(file)}:${i + 1}]: ${line.trim().substring(0, 120)}`);
      silentFallbackCount++;
    }
  });
});

console.log(`\nUnsafe writers: ${unsafeCount}`);
console.log(`Silent fallbacks: ${silentFallbackCount}`);
