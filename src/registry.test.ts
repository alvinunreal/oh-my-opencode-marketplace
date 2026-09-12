import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildRegistry,
  buildV3Registry,
  MAX_AVATAR_BYTES,
  makeRegistryIndex,
  registryPaths,
  validateRegistry,
  validateV3Registry,
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

function v3Bundle(
  id = 'alvin/test-package',
  version = '1.0.0',
): MarketplacePackageBundle {
  const source = bundle(id, version);
  return MarketplacePackageBundleSchema.parse({
    manifest: {
      ...source.manifest,
      schemaVersion: 3,
      routing: {
        lane: 'Contract test lane.',
        stats: ['Fast', 'Focused'],
        delegateWhen: ['The request matches the contract test scope.'],
        avoid: ['Unbounded work.'],
      },
      compatibility: { plugin: '>=3.0.0-beta.6 <4.0.0' },
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

async function writeV3Bundle(
  root: string,
  id: string,
  version: string,
  source: unknown = v3Bundle(id, version),
): Promise<void> {
  const [publisher, name] = id.split('/');
  const path = resolve(root, 'packages/v3', publisher, name, version, 'package.json');
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
}

async function rootWithV3Bundles(
  values: Array<[string, string]> = [['alvin/test-package', '1.0.0']],
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'marketplace-v3-test-'));
  temporaryRoots.push(root);
  for (const [id, version] of values) {
    await writeV3Bundle(root, id, version);
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

function squareAvatar(): Buffer {
  return Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'marketplace-git-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  for (const version of ['v1', 'v2', 'v3']) {
    await mkdir(resolve(root, `dist/${version}/artifacts/alvin/test`), {
      recursive: true,
    });
    await writeFile(
      resolve(root, `dist/${version}/artifacts/alvin/test/1.0.0.json`),
      '{}',
    );
    await writeFile(
      resolve(root, `dist/${version}/index.json`),
      '{"entries":[]}\n',
    );
  }
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
  return root;
}

async function writeAvatar(root: string, id = 'alvin/test-package', version = '1.0.0', value = squareAvatar()): Promise<string> {
  return writeAvatarInRoot(root, 'v2', id, version, value);
}

async function writeV3Avatar(root: string, id = 'alvin/test-package', version = '1.0.0', value = squareAvatar()): Promise<string> {
  return writeAvatarInRoot(root, 'v3', id, version, value);
}

async function writeAvatarInRoot(
  root: string,
  registryVersion: 'v2' | 'v3',
  id: string,
  version: string,
  value: Buffer,
): Promise<string> {
  const [publisher, name] = id.split('/');
  const path = resolve(
    root,
    'packages',
    registryVersion,
    publisher,
    name,
    version,
    'avatar.webp',
  );
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, value);
  return path;
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
    expect(index.retirements).toEqual([]);
    expect(validated.entries[0]?.artifactPath).toBe(
      'artifacts/alvin/test-package/1.0.0.json',
    );
    expect(await readFile(resolve(registryPaths(root).output, 'index.json'), 'utf8'))
      .toContain('alvin/test-package');
  });

  test('builds an independent v3 registry with structured routing metadata', async () => {
    const root = await rootWithV3Bundles();

    const index = await buildV3Registry(root);
    const validated = await validateV3Registry(root);

    expect(index.entries).toHaveLength(1);
    expect(index.retirements).toEqual([]);
    expect(validated.entries[0]?.digest.domain).toBe('marketplace-agent-bundle-v3');
    expect(validated.entries[0]?.summary.routing).toEqual({
      lane: 'Contract test lane.',
      stats: ['Fast', 'Focused'],
      delegateWhen: ['The request matches the contract test scope.'],
      avoid: ['Unbounded work.'],
    });
    expect(await readFile(resolve(registryPaths(root).v3Output, 'index.json'), 'utf8'))
      .toContain('marketplace-agent-bundle-v3');
  });

  test('publishes an optional square WebP avatar separately from the manifest', async () => {
    const root = await rootWithBundles();
    const sourceAvatar = await writeAvatar(root);

    await buildRegistry(root);
    const output = registryPaths(root).output;
    const artifactAvatar = resolve(
      output,
      'artifacts/alvin/test-package/1.0.0.webp',
    );

    expect(await readFile(artifactAvatar)).toEqual(await readFile(sourceAvatar));
    expect(await readFile(resolve(output, 'index.json'), 'utf8')).not.toContain('avatar');
    expect(await readFile(resolve(output, 'artifacts/alvin/test-package/1.0.0.json'), 'utf8')).not.toContain('avatar');
    await expect(validateRegistry(root)).resolves.toBeDefined();
  });

  test('publishes v3 avatars with the same immutable validation', async () => {
    const root = await rootWithV3Bundles();
    const sourceAvatar = await writeV3Avatar(root);

    await buildV3Registry(root);
    const artifactAvatar = resolve(
      registryPaths(root).v3Output,
      'artifacts/alvin/test-package/1.0.0.webp',
    );

    expect(await readFile(artifactAvatar)).toEqual(await readFile(sourceAvatar));
    await expect(validateV3Registry(root)).resolves.toBeDefined();
  });

  test('rejects invalid, non-square, and oversized avatars', async () => {
    const invalidRoot = await rootWithBundles();
    await writeAvatar(invalidRoot, 'alvin/test-package', '1.0.0', Buffer.from('not a WebP'));
    await expect(buildRegistry(invalidRoot)).rejects.toThrow(/valid WebP/);

    const nonSquareRoot = await rootWithBundles();
    const nonSquare = squareAvatar();
    nonSquare[21] = 1;
    await writeAvatar(nonSquareRoot, 'alvin/test-package', '1.0.0', nonSquare);
    await expect(buildRegistry(nonSquareRoot)).rejects.toThrow(/square/);

    const oversizedRoot = await rootWithBundles();
    await writeAvatar(
      oversizedRoot,
      'alvin/test-package',
      '1.0.0',
      Buffer.alloc(MAX_AVATAR_BYTES + 1),
    );
    await expect(buildRegistry(oversizedRoot)).rejects.toThrow(/byte limit/);
  });

  test('detects modified and stale immutable avatar artifacts', async () => {
    const root = await rootWithBundles();
    await writeAvatar(root);
    const output = registryPaths(root).output;
    await buildRegistry(root);
    const artifact = resolve(output, 'artifacts/alvin/test-package/1.0.0.webp');

    const modified = squareAvatar();
    modified[29] ^= 1;
    await writeFile(artifact, modified);
    await expect(validateRegistry(root)).rejects.toThrow(/differs from its immutable source avatar/);
    await expect(buildRegistry(root)).rejects.toThrow(/immutable source avatar/);
  });

  test('removes generated artifacts when their source package is removed', async () => {
    const root = await rootWithBundles([
      ['alvin/removed-package', '1.0.0'],
      ['alvin/active-package', '1.0.0'],
    ]);
    await buildRegistry(root);

    await rm(resolve(root, 'packages/v2/alvin/removed-package'), {
      recursive: true,
    });
    await writeFile(
      resolve(root, 'catalog.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          agents: [{ id: 'alvin/active-package', state: 'active' }],
        },
        null,
        2,
      )}\n`,
    );

    const index = await buildRegistry(root);

    expect(index.entries.map((entry) => entry.id)).toEqual(['alvin/active-package']);
    await expect(
      readFile(
        resolve(
          registryPaths(root).output,
          'artifacts/alvin/removed-package/1.0.0.json',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(validateRegistry(root)).resolves.toEqual(index);
  });

  test('supports an empty v2 source tree after package removal', async () => {
    const root = await rootWithV3Bundles();

    const index = await buildRegistry(root);

    expect(index.entries).toEqual([]);
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

  test('removes stale v3 artifacts during a rebuild', async () => {
    const root = await rootWithV3Bundles();
    await buildV3Registry(root);
    const staleArtifact = resolve(
      registryPaths(root).v3Output,
      'artifacts/alvin/test-package/9.9.9.json',
    );
    await mkdir(resolve(staleArtifact, '..'), { recursive: true });
    await writeFile(staleArtifact, '{}', 'utf8');

    await buildV3Registry(root);

    await expect(readFile(staleArtifact, 'utf8')).rejects.toThrow();
    await expect(validateV3Registry(root)).resolves.toBeDefined();
  });

  test('detects modified, missing, and untracked generated output', async () => {
    const modified = await gitFixture();
    await writeFile(resolve(modified, 'dist/v1/index.json'), 'changed\n');
    expect(() => verifyGeneratedOutput(modified)).toThrow(/differs/);

    const missing = await gitFixture();
    await rm(resolve(missing, 'dist/v2/index.json'));
    expect(() => verifyGeneratedOutput(missing)).toThrow(/differs|missing/);

    const untracked = await gitFixture();
    await writeFile(resolve(untracked, 'dist/v3/unexpected.json'), '{}');
    expect(() => verifyGeneratedOutput(untracked)).toThrow(/untracked/);
  });

});
