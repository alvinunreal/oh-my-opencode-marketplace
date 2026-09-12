import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  canonicalizeRegistryCatalog,
  readRegistryCatalog,
  retiredCatalogIds,
  validateCatalogSourceIds,
  type RegistryCatalog,
} from './catalog';
import {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceRegistryIndex,
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryIndex,
  MarketplacePackageBundleSchema,
  MarketplaceRegistryIndexSchema,
  MarketplaceVersionSchema,
  validateMarketplaceRegistryEntry,
  type MarketplacePackageBundle,
  type MarketplaceRegistryEntry,
  type MarketplaceRegistryIndex,
  type MarketplaceRegistryRetirement,
} from 'oh-my-opencode-slim/marketplace-contract';

export interface RegistryPaths {
  readonly root: string;
  readonly v2Packages: string;
  readonly output: string;
  readonly catalog: string;
}

export interface SourceBundle {
  readonly path: string;
  readonly relativePath: string;
  readonly bundle: MarketplacePackageBundle;
  readonly entry: MarketplaceRegistryEntry;
}

export function registryPaths(root = process.cwd()): RegistryPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    v2Packages: resolve(absoluteRoot, 'packages', 'v2'),
    output: resolve(absoluteRoot, 'dist', 'v2'),
    catalog: resolve(absoluteRoot, 'catalog.json'),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in ${path}: ${detail}`);
  }
}

function parseBundle(value: unknown, path: string): MarketplacePackageBundle {
  const parsed = MarketplacePackageBundleSchema.safeParse(value);
  if (!parsed.success) {
    fail(`Invalid marketplace bundle ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function validateSourceIdentity(
  bundle: MarketplacePackageBundle,
  path: string,
  packagesRoot: string,
): void {
  const relativePath = relative(packagesRoot, path).split(sep).join('/');
  const parts = relativePath.split('/');
  if (
    parts.length !== 4 ||
    parts[3] !== 'package.json' ||
    parts.some((part) => part.length === 0)
  ) {
    fail(
      `Source bundle must be at packages/<publisher>/<package>/<version>/package.json: ${relativePath}`,
    );
  }

  const [publisher, name, version] = parts;
  const id = `${publisher}/${name}`;
  if (!MarketplaceVersionSchema.safeParse(version).success) {
    fail(`Noncanonical marketplace version directory ${version} in ${path}`);
  }
  const manifest = bundle.manifest;
  if (manifest.id !== id || manifest.version !== version) {
    fail(
      `Bundle identity ${manifest.id}@${manifest.version} does not match ${id}@${version} in ${path}`,
    );
  }
}

export async function readSourceBundles(
  packagesRoot: string,
): Promise<SourceBundle[]> {
  let files: string[];
  try {
    files = await filesUnder(packagesRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read source package tree ${packagesRoot}: ${detail}`);
  }

  const packageFiles = files.filter((path) => path.endsWith('/package.json'));
  if (packageFiles.length === 0) {
    fail(`No marketplace bundles found under ${packagesRoot}`);
  }

  const seen = new Set<string>();
  const bundles: SourceBundle[] = [];
  for (const path of packageFiles.sort()) {
    const bundle = parseBundle(await readJson(path), path);
    validateSourceIdentity(bundle, path, packagesRoot);
    const key = `${bundle.manifest.id}@${bundle.manifest.version}`;
    if (seen.has(key)) {
      fail(`Duplicate marketplace bundle ${key}`);
    }
    seen.add(key);
    bundles.push({
      path,
      relativePath: relative(packagesRoot, path).split(sep).join('/'),
      bundle,
      entry: createMarketplaceRegistryEntry(bundle),
    });
  }
  return bundles;
}

export function makeRegistryIndex(
  entries: readonly MarketplaceRegistryEntry[],
  catalog?: RegistryCatalog,
): MarketplaceRegistryIndex {
  const permanentRetirements = createMarketplaceRegistryIndex([]).retirements;
  const retirements: MarketplaceRegistryRetirement[] = [
    ...permanentRetirements,
    ...(catalog
      ? [...retiredCatalogIds(catalog)].map((id) => ({ id }))
      : []),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const retiredIds = new Set(retirements.map(({ id }) => id));
  return createMarketplaceRegistryIndex(
    entries.filter((entry) => !retiredIds.has(entry.id)),
    retirements,
  );
}

async function writeCanonicalJson(path: string, value: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${value}\n`, 'utf8');
}

async function writeImmutableArtifact(path: string, value: string): Promise<void> {
  const canonical = `${value}\n`;
  try {
    const existing = await readFile(path, 'utf8');
    if (existing !== canonical) {
      fail(`Published v2 artifact differs from its immutable source bundle: ${path}`);
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, canonical, 'utf8');
  }
}

export async function buildRegistry(root = process.cwd()): Promise<MarketplaceRegistryIndex> {
  const paths = registryPaths(root);
  const bundles = await readSourceBundles(paths.v2Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
  const index = makeRegistryIndex(bundles.map((bundle) => bundle.entry), catalog);

  await mkdir(paths.output, { recursive: true });
  for (const source of bundles) {
    const artifactPath = resolve(paths.output, source.entry.artifactPath);
    await writeImmutableArtifact(
      artifactPath,
      canonicalizeMarketplaceBundle(source.bundle),
    );
  }
  await writeCanonicalJson(
    resolve(paths.output, 'index.json'),
    canonicalizeMarketplaceRegistryIndex(index),
  );
  await writeFile(
    resolve(paths.output, 'catalog.json'),
    canonicalizeRegistryCatalog(catalog),
    'utf8',
  );
  return index;
}

async function validateArtifacts(
  paths: RegistryPaths,
  bundles: readonly SourceBundle[],
  index: MarketplaceRegistryIndex,
): Promise<void> {
  const retiredIds = new Set(index.retirements.map((retirement) => retirement.id));
  for (const entry of index.entries) {
    if (retiredIds.has(entry.id)) {
      fail(`Retired package is present in v2 entries: ${entry.id}`);
    }
  }
  const activeBundles = bundles.filter((bundle) => !retiredIds.has(bundle.entry.id));
  const expectedEntries = new Map(
    activeBundles.map((bundle) => [bundle.entry.artifactPath, bundle]),
  );
  const expectedArtifacts = new Map(
    bundles.map((bundle) => [bundle.entry.artifactPath, bundle]),
  );
  const indexed = new Map(index.entries.map((entry) => [entry.artifactPath, entry]));
  if (
    expectedEntries.size !== indexed.size ||
    [...expectedEntries.keys()].some((key) => !indexed.has(key))
  ) {
    fail('dist/v2/index.json does not contain exactly the source bundle set');
  }

  let artifactFiles: string[];
  try {
    artifactFiles = await filesUnder(resolve(paths.output, 'artifacts'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read v2 registry artifacts: ${detail}`);
  }
  const artifactPaths = new Set(
    artifactFiles.map((path) => relative(paths.output, path).split(sep).join('/')),
  );
  if (
    artifactPaths.size !== expectedArtifacts.size ||
    [...expectedArtifacts.keys()].some((key) => !artifactPaths.has(key))
  ) {
    fail('V2 registry artifacts are stale, deleted, or unexpected');
  }

  for (const source of bundles) {
    const artifactPath = resolve(paths.output, source.entry.artifactPath);
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = parseBundle(await readJson(artifactPath), artifactPath);
    if (artifactText.trim() !== canonicalizeMarketplaceBundle(artifact)) {
      fail(`V2 registry artifact is not canonical: ${source.entry.artifactPath}`);
    }
    validateMarketplaceRegistryEntry(source.entry, artifact);
    if (retiredIds.has(source.entry.id)) continue;
    const entry = indexed.get(source.entry.artifactPath);
    if (!entry) fail(`Missing registry entry ${source.entry.id}@${source.entry.version}`);
    validateMarketplaceRegistryEntry(entry, artifact);
  }
}

export async function validateRegistry(root = process.cwd()): Promise<MarketplaceRegistryIndex> {
  const paths = registryPaths(root);
  const bundles = await readSourceBundles(paths.v2Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
  const indexPath = resolve(paths.output, 'index.json');
  const index = MarketplaceRegistryIndexSchema.parse(await readJson(indexPath));
  const canonicalIndex = canonicalizeMarketplaceRegistryIndex(index);
  const indexText = await readFile(indexPath, 'utf8');
  if (indexText.trim() !== canonicalIndex) {
    fail('dist/v2/index.json is not canonical');
  }
  const expected = makeRegistryIndex(bundles.map((bundle) => bundle.entry), catalog);
  if (canonicalIndex !== canonicalizeMarketplaceRegistryIndex(expected)) {
    fail('dist/v2/index.json is stale or has modified registry metadata');
  }
  const catalogOutput = resolve(paths.output, 'catalog.json');
  if ((await readFile(catalogOutput, 'utf8')) !== canonicalizeRegistryCatalog(catalog)) {
    fail('dist/v2/catalog.json is stale or has modified registry metadata');
  }
  await validateArtifacts(paths, bundles, index);
  return index;
}

export function verifyAdditiveAgainstGit(
  baseRef: string | undefined = undefined,
  root = process.cwd(),
): void {
  const head = revision(root, 'HEAD');
  if (!head) return;
  ensureCompleteHistory(root, head);
  const requestedReference = baseRef ?? process.env.REGISTRY_BASE_REF;
  const reference =
    requestedReference === undefined || requestedReference === 'HEAD^'
      ? undefined
      : revision(root, requestedReference);
  if (requestedReference !== undefined && !reference) {
    fail(`Cannot resolve required history reference ${requestedReference}`);
  }
  if (reference && !isAncestor(root, reference, head)) {
    fail(`History reference ${reference} is not an ancestor of ${head}`);
  }

  const commits = gitOutput(root, ['rev-list', '--parents', '--reverse', head])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  for (const [commit, ...parents] of commits) {
    const edges = parents.length > 0 ? parents : [undefined];
    for (const parent of edges) {
      verifyHistoryEdge(root, parent, commit);
    }
  }
}

function verifyHistoryEdge(
  root: string,
  parent: string | undefined,
  commit: string,
): void {
  const args = parent
    ? ['diff', '--name-status', '--no-renames', parent, commit]
    : ['diff-tree', '--root', '--name-status', '--no-renames', '--no-commit-id', '-r', commit];
  const diff = gitOutput(root, [...args, '--', 'packages', 'dist/v1', 'dist/v2']);
  const violations: string[] = [];
  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    if (!status || !path) continue;
    if (path === 'dist/v1/index.json') {
      if (status !== 'A' && status !== 'M') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v1/artifacts/')) {
      if (status !== 'A') violations.push(`${status} ${path}`);
    } else if (path.startsWith('packages/')) {
      if (status !== 'A') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v1/')) {
      violations.push(`${status} ${path}`);
    } else if (path === 'dist/v2/index.json' || path === 'dist/v2/catalog.json') {
      if (status !== 'A' && status !== 'M') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v2/artifacts/')) {
      if (status !== 'A') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v2/')) {
      violations.push(`${status} ${path}`);
    }
  }
  if (violations.length > 0) {
    fail(
      `Published artifacts are not additive-only between ${parent ?? 'empty tree'} and ${commit}:\n${violations.join('\n')}`,
    );
  }
}

function gitOutput(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Git history verification failed: ${detail}`);
  }
}

function revision(root: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function ensureCompleteHistory(root: string, head: string): void {
  let shallow: string;
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot determine Git history completeness: ${detail}`);
  }
  if (shallow !== 'false') {
    fail('Complete Git history is required; repository is shallow or unknown');
  }
  for (const line of gitOutput(root, ['rev-list', '--parents', head])
    .split('\n')
    .filter(Boolean)) {
    for (const parent of line.split(' ').slice(1)) {
      if (!revision(root, parent)) {
        fail(`Complete Git history is required; missing parent ${parent}`);
      }
    }
  }
}

export function verifyGeneratedOutput(root = process.cwd()): void {
  if (!revision(root, 'HEAD')) return;
  for (const version of ['v1', 'v2']) {
    const output = `dist/${version}`;
    const tracked = gitOutput(root, ['ls-files', '--', output])
      .split('\n')
      .filter(Boolean);
    if (tracked.length === 0) {
      fail(`Checked-in generated output is missing ${output} files`);
    }
    for (const args of [
      ['diff', '--quiet', '--', output],
      ['diff', '--cached', '--quiet', '--', output],
    ]) {
      try {
        execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      } catch {
        fail('Checked-in generated output differs from the release input');
      }
    }
    const untracked = gitOutput(root, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      output,
    ]).trim();
    if (untracked) {
      fail(`Generated output contains untracked ${output} files`);
    }
  }
}

export async function verifyForDeployment(root = process.cwd()): Promise<void> {
  await validateRegistry(root);
  verifyAdditiveAgainstGit(undefined, root);
  verifyGeneratedOutput(root);
  verifyCurrentMain(root);
}

export function verifyCurrentMain(root = process.cwd()): void {
  try {
    execFileSync('git', ['fetch', '--no-tags', 'origin', 'main', '--prune'], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot refresh origin/main for deployment: ${detail}`);
  }
  const head = revision(root, 'HEAD');
  const main = revision(root, 'refs/remotes/origin/main');
  if (!head || !main) {
    fail('Deployment requires a current checked-out main revision');
  }
  if (head !== main) {
    fail(`Deployment revision ${head} is not current origin/main ${main}`);
  }
}
