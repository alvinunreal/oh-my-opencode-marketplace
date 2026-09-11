import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildRegistry,
  makeRegistryIndex,
  registryPaths,
  validateRegistry,
  verifyAdditiveAgainstGit,
  verifyGeneratedOutput,
} from './registry';
import {
  MarketplacePackageBundleSchema,
  createMarketplaceRegistryEntry,
  type MarketplacePackageBundle,
} from 'oh-my-opencode-slim/marketplace-contract';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function bundle(
  id = 'alvin/test-package',
  version = '1.0.0',
): MarketplacePackageBundle {
  return MarketplacePackageBundleSchema.parse({
    manifest: {
      id,
      version,
      displayName: 'Test package',
      description: 'A test package with a real contract-shaped manifest.',
      instructions: 'Inspect the request, report evidence, and remain within scope.',
      author: { name: 'Test author' },
      tags: ['test'],
      license: 'MIT',
      compatibility: {
        plugin: '>=3.0.0-beta.1 <4.0.0',
        roleContract: '>=1.0.0 <2.0.0',
      },
      routing: {
        description: 'Use for contract tests.',
        keywords: ['test'],
        delegation: {
          when: 'A contract test needs a package.',
          preferredRoles: ['explorer'],
        },
      },
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: {
        tools: ['read'],
        permissions: ['filesystem.read'],
      },
      kind: 'agent',
      baseRole: 'explorer',
      agentName: 'tester',
      overrides: {},
    },
  });
}

async function rootWithBundles(
  values: Array<[string, string]> = [['alvin/test-package', '1.0.0']],
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'marketplace-test-'));
  temporaryRoots.push(root);
  for (const [id, version] of values) {
    await writeBundle(root, id, version);
  }
  return root;
}

async function writeBundle(
  root: string,
  id: string,
  version: string,
  source: unknown = bundle(id, version),
): Promise<void> {
  const [publisher, name] = id.split('/');
  const path = resolve(root, 'packages', publisher, name, version, 'package.json');
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function gitFixture(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'marketplace-git-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  await mkdir(resolve(root, 'packages/alvin/test/1.0.0'), { recursive: true });
  await writeFile(resolve(root, 'packages/alvin/test/1.0.0/package.json'), '{}');
  await mkdir(resolve(root, 'dist/v1/artifacts/alvin/test'), { recursive: true });
  await writeFile(resolve(root, 'dist/v1/artifacts/alvin/test/1.0.0.json'), '{}');
  await writeFile(resolve(root, 'dist/v1/index.json'), '{"entries":[]}\n');
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Registry Tests',
    '-c',
    'user.email=registry-tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'base',
  ]);
  return { root, base: git(root, ['rev-parse', 'HEAD']).trim() };
}

function commitFixture(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Registry Tests',
    '-c',
    'user.email=registry-tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}

describe('registry build and validation', () => {
  test('builds and validates a valid source tree', async () => {
    const root = await rootWithBundles();

    const index = await buildRegistry(root);
    const validated = await validateRegistry(root);

    expect(index.entries).toHaveLength(1);
    expect(validated.entries[0]?.artifactPath).toBe(
      'artifacts/alvin/test-package/1.0.0.json',
    );
    expect(await readFile(resolve(registryPaths(root).output, 'index.json'), 'utf8'))
      .toContain('alvin/test-package');
  });

  test('rejects identity mismatch and noncanonical version paths', async () => {
    const mismatchRoot = await rootWithBundles();
    await writeBundle(mismatchRoot, 'alvin/test-package', '1.0.0', bundle('alvin/other'));
    await expect(buildRegistry(mismatchRoot)).rejects.toThrow(/identity/);

    const versionRoot = await mkdtemp(resolve(tmpdir(), 'marketplace-version-'));
    temporaryRoots.push(versionRoot);
    const noncanonical = bundle();
    await writeBundle(versionRoot, 'alvin/test-package', '1.0', {
      ...noncanonical,
      manifest: { ...noncanonical.manifest, version: '1.0' },
    });
    await expect(buildRegistry(versionRoot)).rejects.toThrow(/Invalid marketplace bundle|Noncanonical/);
  });

  test('rejects duplicate entries and noncanonical versions through the contract', async () => {
    const entry = createMarketplaceRegistryEntry(bundle());
    expect(() => makeRegistryIndex([entry, entry])).toThrow(/Duplicate/);
    expect(() =>
      MarketplacePackageBundleSchema.parse({ ...bundle(), manifest: { ...bundle().manifest, version: 'v1.0.0' } }),
    ).toThrow();
  });

  test('produces deterministic output and contract ordering', async () => {
    const root = await rootWithBundles([
      ['alvin/zeta', '1.0.0'],
      ['alvin/alpha', '1.0.0'],
      ['alvin/alpha', '1.1.0'],
    ]);
    await buildRegistry(root);
    const output = registryPaths(root).output;
    const firstIndex = await readFile(resolve(output, 'index.json'), 'utf8');
    const firstArtifact = await readFile(
      resolve(output, 'artifacts/alvin/alpha/1.0.0.json'),
      'utf8',
    );

    await buildRegistry(root);
    expect(await readFile(resolve(output, 'index.json'), 'utf8')).toBe(firstIndex);
    expect(
      await readFile(resolve(output, 'artifacts/alvin/alpha/1.0.0.json'), 'utf8'),
    ).toBe(firstArtifact);
    expect(JSON.parse(firstIndex).entries.map((entry: { id: string; version: string }) => `${entry.id}@${entry.version}`)).toEqual([
      'alvin/alpha@1.0.0',
      'alvin/alpha@1.1.0',
      'alvin/zeta@1.0.0',
    ]);
  });

  test('detects deleted, modified, and stale version artifacts', async () => {
    const root = await rootWithBundles();
    const output = registryPaths(root).output;
    await buildRegistry(root);
    const artifact = resolve(output, 'artifacts/alvin/test-package/1.0.0.json');

    await rm(artifact);
    await expect(validateRegistry(root)).rejects.toThrow(/stale, deleted/);

    await buildRegistry(root);
    const modified = JSON.parse(await readFile(artifact, 'utf8')) as {
      manifest: { instructions: string };
    };
    modified.manifest.instructions = 'Modified after publication.';
    await writeFile(artifact, JSON.stringify(modified), 'utf8');
    await expect(validateRegistry(root)).rejects.toThrow(/digest/);

    await buildRegistry(root);
    await mkdir(resolve(output, 'artifacts/alvin/test-package'), { recursive: true });
    await writeFile(
      resolve(output, 'artifacts/alvin/test-package/9.9.9.json'),
      '{}',
      'utf8',
    );
    await expect(validateRegistry(root)).rejects.toThrow(/stale, deleted/);
  });

  test('allows only new published versions in immutable Git history', async () => {
    const fixture = await gitFixture();
    await mkdir(resolve(fixture.root, 'packages/alvin/test/2.0.0'), { recursive: true });
    await writeFile(resolve(fixture.root, 'packages/alvin/test/2.0.0/package.json'), '{}');
    await writeFile(
      resolve(fixture.root, 'dist/v1/artifacts/alvin/test/2.0.0.json'),
      '{}',
    );
    await writeFile(resolve(fixture.root, 'dist/v1/index.json'), '{"entries":[2]}\n');
    commitFixture(fixture.root, 'add version');

    expect(() => verifyAdditiveAgainstGit(fixture.base, fixture.root)).not.toThrow();
  });

  test('checks every history edge instead of trusting the latest diff', async () => {
    const fixture = await gitFixture();
    await writeFile(
      resolve(fixture.root, 'dist/v1/artifacts/alvin/test/1.0.0.json'),
      'mutated',
    );
    commitFixture(fixture.root, 'mutate old version');
    await writeFile(resolve(fixture.root, 'dist/v1/index.json'), '{"entries":[3]}\n');
    commitFixture(fixture.root, 'add later catalog change');

    expect(() => verifyAdditiveAgainstGit(fixture.base, fixture.root)).toThrow(
      /additive-only/,
    );
  });

  test('treats a repository without a prior commit as bootstrap', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'marketplace-bootstrap-'));
    temporaryRoots.push(root);
    git(root, ['init', '--quiet']);
    expect(() => verifyAdditiveAgainstGit('HEAD^', root)).not.toThrow();
  });

  test('fails closed for a depth-1 file clone', async () => {
    const source = await gitFixture();
    await writeFile(resolve(source.root, 'dist/v1/index.json'), '{"entries":[4]}\n');
    commitFixture(source.root, 'second published state');

    const cloneParent = await mkdtemp(resolve(tmpdir(), 'marketplace-clone-'));
    temporaryRoots.push(cloneParent);
    const clone = resolve(cloneParent, 'depth-one');
    git(cloneParent, ['clone', '--quiet', '--depth', '1', `file://${source.root}`, clone]);

    expect(() => verifyAdditiveAgainstGit(undefined, clone)).toThrow(/shallow/);
  });

  test('rejects artifact modification, deletion, and rename', async () => {
    for (const change of ['modify', 'delete', 'rename'] as const) {
      const fixture = await gitFixture();
      const oldPath = resolve(fixture.root, 'dist/v1/artifacts/alvin/test/1.0.0.json');
      if (change === 'modify') {
        await writeFile(oldPath, 'changed');
      } else if (change === 'delete') {
        await rm(oldPath);
      } else {
        git(fixture.root, [
          'mv',
          'dist/v1/artifacts/alvin/test/1.0.0.json',
          'dist/v1/artifacts/alvin/test/renamed.json',
        ]);
      }
      commitFixture(fixture.root, change);
      expect(() => verifyAdditiveAgainstGit(fixture.base, fixture.root)).toThrow(
        /additive-only/,
      );
    }
  });

  test('allows mutable index-only history changes but rejects generated drift', async () => {
    const fixture = await gitFixture();
    await writeFile(resolve(fixture.root, 'dist/v1/index.json'), '{"entries":[1]}\n');
    commitFixture(fixture.root, 'catalog update');
    expect(() => verifyAdditiveAgainstGit(fixture.base, fixture.root)).not.toThrow();

    await writeFile(resolve(fixture.root, 'dist/v1/index.json'), '{"entries":[2]}\n');
    expect(() => verifyGeneratedOutput(fixture.root)).toThrow();
  });

  test('rejects missing and untracked generated output', async () => {
    const missing = await gitFixture();
    await rm(resolve(missing.root, 'dist/v1/artifacts/alvin/test/1.0.0.json'));
    expect(() => verifyGeneratedOutput(missing.root)).toThrow();

    const untracked = await gitFixture();
    await writeFile(
      resolve(untracked.root, 'dist/v1/unexpected.json'),
      '{}',
    );
    expect(() => verifyGeneratedOutput(untracked.root)).toThrow(/untracked/);
  });
});
