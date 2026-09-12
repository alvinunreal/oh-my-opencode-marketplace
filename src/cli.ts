import {
  buildAllRegistries,
  validateAllRegistries,
  verifyForDeployment,
  verifyCurrentMain,
  verifyGeneratedOutput,
} from './registry';
import { readRegistryCatalog } from './catalog';

const command = process.argv[2];

try {
  if (command === 'build') {
    await buildAllRegistries();
    console.log('Built v2 and v3 registry artifacts');
  } else if (command === 'validate') {
    await validateAllRegistries();
    console.log('Validated v2 and v3 registry artifacts');
  } else if (command === 'verify-generated') {
    verifyGeneratedOutput();
    console.log('Checked-in generated output is unchanged');
  } else if (command === 'verify-main') {
    verifyCurrentMain();
    console.log('Checked-out revision is current origin/main');
  } else if (command === 'deploy') {
    await verifyForDeployment();
    console.log('Deployment preflight passed');
  } else if (command === 'catalog:list') {
    const catalog = await readRegistryCatalog('catalog.json');
    for (const agent of catalog.agents) {
      console.log(`${agent.id}\t${agent.state}`);
    }
  } else {
    throw new Error(
      'Usage: bun run src/cli.ts <build|validate|verify-generated|verify-main|deploy|catalog:list> [args]',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
