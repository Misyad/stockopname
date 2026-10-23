#!/usr/bin/env node
import { migrationDryRun } from '../src/services/migration.js';

function usage() {
  return 'Usage: node scripts/migrate-sheets.js dry-run --source <dir> --output <dir> --mapping <file>';
}

function options(argv) {
  if (argv[0] !== 'dry-run') throw new Error(usage());
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--output', '--mapping'].includes(flag) || !value || value.startsWith('--')) {
      throw new Error(usage());
    }
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate option: ${flag}`);
    values[flag] = value;
  }
  if (Object.keys(values).length !== 3) throw new Error(usage());
  return {
    sourceDirectory: values['--source'],
    outputDirectory: values['--output'],
    mappingPath: values['--mapping'],
  };
}

try {
  const result = await migrationDryRun(options(process.argv.slice(2)));
  console.log(`MIGRATION_DRY_RUN=${result.status}`);
  console.log(`EVIDENCE_DIR=${result.outputDirectory}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
