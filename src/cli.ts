import {
  buildRegistry,
  validateRegistry,
  verifyAdditiveAgainstGit,
  verifyForDeployment,
  verifyCurrentMain,
  verifyGeneratedOutput,
} from './registry';

const command = process.argv[2];

try {
  if (command === 'build') {
    const index = await buildRegistry();
    console.log(`Built ${index.entries.length} registry artifacts in dist/v1/`);
  } else if (command === 'validate') {
    const index = await validateRegistry();
    console.log(`Validated ${index.entries.length} registry artifacts`);
  } else if (command === 'verify-additive') {
    verifyAdditiveAgainstGit(
      process.argv[3] === '--' ? process.argv[4] : process.argv[3],
    );
    console.log('Published artifacts are additive-only');
  } else if (command === 'verify-generated') {
    verifyGeneratedOutput();
    console.log('Checked-in generated output is unchanged');
  } else if (command === 'verify-main') {
    verifyCurrentMain();
    console.log('Checked-out revision is current origin/main');
  } else if (command === 'deploy') {
    await verifyForDeployment();
    console.log('Deployment preflight passed');
  } else {
    throw new Error(
      'Usage: bun run src/cli.ts <build|validate|verify-additive|verify-generated|verify-main|deploy> [base-ref]',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
