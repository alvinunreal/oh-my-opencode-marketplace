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
      schemaVersion: 2,
      agentName: 'tester',
      prompt: 'Inspect the request, report evidence, and remain within scope.',
      author: { name: 'Test author' },
      tags: ['test'],
      license: 'MIT',
      compatibility: {
        plugin: '>=3.0.0-beta.3 <4.0.0',
      },
      routing: {
        description: 'Use for contract tests.',
        when: 'A contract test needs a package.',
        keywords: ['test'],
      },
      skills: [],
      mcps: [],
      tools: ['read'],
      model: { source: 'builtin' },
      extends: { builtin: 'explorer', promptMode: 'append' },
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
  await writeFile(
    resolve(root, 'catalog.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        agents: [...new Set(values.map(([id]) => id))]
          .sort()
          .map((id) => ({ id, state: 'active' })),
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

async function writeBundle(
  root: string,
  id: string,
  version: string,
  source: unknown = bundle(id, version),
): Promise<void> {
  const [publisher, name] = id.split('/');
  const path = resolve(root, 'packages', 'v2', publisher, name, version, 'package.json');
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
    await mkdir(resolve(root, 'dist/v2/artifacts/alvin/test'), { recursive: true });
    await writeFile(resolve(root, 'dist/v2/artifacts/alvin/test/1.0.0.json'), '{}');
    await writeFile(
      resolve(root, 'dist/v2/index.json'),
      '{"schemaVersion":3,"entries":[],"retirements":[]}\n',
    );
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
  test('leaves the published v1 output byte-identical', async () => {
    const root = await rootWithBundles();
    const v1Index = resolve(root, 'dist/v1/index.json');
    const v1Artifact = resolve(
      root,
      'dist/v1/artifacts/alvin/test-package/1.0.0.json',
    );
    await mkdir(resolve(v1Artifact, '..'), { recursive: true });
    await writeFile(v1Index, 'published-v1-index\n', 'utf8');
    await writeFile(v1Artifact, 'published-v1-artifact\n', 'utf8');

    await buildRegistry(root);

    expect(await readFile(v1Index, 'utf8')).toBe('published-v1-index\n');
    expect(await readFile(v1Artifact, 'utf8')).toBe('published-v1-artifact\n');
  });

  test('builds and validates a valid source tree', async () => {
    const root = await rootWithBundles();

    const index = await buildRegistry(root);
    const validated = await validateRegistry(root);

    expect(index.entries).toHaveLength(1);
    expect(index.retirements.map(({ id }) => id)).toEqual([
      'alvin/deepwork-implementer',
      'alvin/deepwork-recon',
      'alvin/deepwork-reviewer',
    ]);
    expect(validated.entries[0]?.artifactPath).toBe(
      'artifacts/alvin/test-package/1.0.0.json',
    );
    expect(await readFile(resolve(registryPaths(root).output, 'index.json'), 'utf8'))
      .toContain('alvin/test-package');
  });

  test('retires packages without deleting their immutable artifacts', async () => {
    const root = await rootWithBundles([
      ['alvin/evidence-scout', '1.0.0'],
      ['alvin/visual-inspector', '1.0.0'],
      ['alvin/active-package', '1.0.0'],
    ]);
    await writeFile(
      resolve(root, 'catalog.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          agents: [
            { id: 'alvin/active-package', state: 'active' },
            { id: 'alvin/evidence-scout', state: 'retired' },
            { id: 'alvin/visual-inspector', state: 'retired' },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const index = await buildRegistry(root);

    expect(index.entries.map((entry) => entry.id)).toEqual(['alvin/active-package']);
    expect(index.retirements.map(({ id }) => id)).toEqual([
      'alvin/deepwork-implementer',
      'alvin/deepwork-recon',
      'alvin/deepwork-reviewer',
      'alvin/evidence-scout',
      'alvin/visual-inspector',
    ]);
    await expect(
      readFile(
        resolve(
          registryPaths(root).output,
          'artifacts/alvin/evidence-scout/1.0.0.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('alvin/evidence-scout');
    await expect(validateRegistry(root)).resolves.toEqual(index);
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

  test('accepts only v2 agent manifests without legacy profile fields', () => {
    expect(bundle().manifest.schemaVersion).toBe(2);
    expect(() =>
      MarketplacePackageBundleSchema.parse({
        ...bundle(),
        manifest: { ...bundle().manifest, kind: 'profile' },
      }),
    ).toThrow();
    expect(() =>
      MarketplacePackageBundleSchema.parse({
        ...bundle(),
        manifest: { ...bundle().manifest, capabilities: { tools: ['read'] } },
      }),
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
      manifest: { prompt: string };
    };
    modified.manifest.prompt = 'Modified after publication.';
    await writeFile(artifact, JSON.stringify(modified), 'utf8');
    await expect(validateRegistry(root)).rejects.toThrow(/digest/);

    await expect(buildRegistry(root)).rejects.toThrow(/immutable source bundle/);

    const staleRoot = await rootWithBundles();
    await buildRegistry(staleRoot);
    const staleOutput = registryPaths(staleRoot).output;
    await mkdir(resolve(staleOutput, 'artifacts/alvin/test-package'), { recursive: true });
    await writeFile(
      resolve(staleOutput, 'artifacts/alvin/test-package/9.9.9.json'),
      '{}',
      'utf8',
    );
    await expect(validateRegistry(staleRoot)).rejects.toThrow(/stale, deleted/);
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

  test('applies additive history rules to v2 artifacts', async () => {
    const fixture = await gitFixture();
    await writeFile(
      resolve(fixture.root, 'dist/v2/artifacts/alvin/test/1.0.0.json'),
      'changed',
    );
    commitFixture(fixture.root, 'mutate v2 artifact');

    expect(() => verifyAdditiveAgainstGit(fixture.base, fixture.root)).toThrow(
      /additive-only/,
    );
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
