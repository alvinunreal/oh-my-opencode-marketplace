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
  validateCatalogContainsSourceIds,
  validateCatalogSourceIds,
  type RegistryCatalog,
} from './catalog';
import {
  canonicalizeMarketplaceValue,
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceRegistryIndex,
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryEntryV3,
  createMarketplaceRegistryIndex,
  createMarketplaceRegistryIndexV3,
  MarketplacePackageBundleSchema,
  MarketplacePackageBundleV3Schema,
  MarketplaceRegistryIndexSchema,
  MarketplaceVersionSchema,
  parseMarketplaceRegistryIndexV3,
  validateMarketplaceRegistryEntry,
  validateMarketplaceRegistryEntryV3,
  type MarketplacePackageBundle,
  type MarketplaceRegistryEntry,
  type MarketplaceRegistryEntryV3,
  type MarketplaceRegistryIndex,
  type MarketplaceRegistryIndexV3,
  type MarketplaceRegistryRetirement,
} from 'oh-my-opencode-slim/marketplace-contract';

export interface RegistryPaths {
  readonly root: string;
  readonly v2Packages: string;
  readonly v3Packages: string;
  readonly output: string;
  readonly v3Output: string;
  readonly catalog: string;
}

interface SourceBundleBase {
  readonly path: string;
  readonly relativePath: string;
  readonly bundle: MarketplacePackageBundle;
  readonly avatarPath?: string;
}

interface GenericSourceBundle<E> {
  readonly path: string;
  readonly relativePath: string;
  readonly bundle: MarketplacePackageBundle;
  readonly entry: E;
  readonly avatarPath?: string;
}

export interface SourceBundle extends SourceBundleBase {
  readonly entry: MarketplaceRegistryEntry;
}

export interface V3SourceBundle extends SourceBundleBase {
  readonly entry: MarketplaceRegistryEntryV3;
}

export const MAX_AVATAR_BYTES = 512 * 1024;

export function registryPaths(root = process.cwd()): RegistryPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    v2Packages: resolve(absoluteRoot, 'packages', 'v2'),
    v3Packages: resolve(absoluteRoot, 'packages', 'v3'),
    output: resolve(absoluteRoot, 'dist', 'v2'),
    v3Output: resolve(absoluteRoot, 'dist', 'v3'),
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

function parseV3Bundle(value: unknown, path: string): MarketplacePackageBundle {
  const parsed = MarketplacePackageBundleV3Schema.safeParse(value);
  if (!parsed.success) {
    fail(`Invalid marketplace v3 bundle ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readAscii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function avatarDimensions(bytes: Uint8Array, path: string): { width: number; height: number } {
  if (bytes.length > MAX_AVATAR_BYTES) {
    fail(`Avatar exceeds the ${MAX_AVATAR_BYTES}-byte limit: ${path}`);
  }
  if (
    bytes.length < 20 ||
    readAscii(bytes, 0) !== 'RIFF' ||
    readAscii(bytes, 8) !== 'WEBP' ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 !==
      bytes.length
  ) {
    fail(`Avatar must be a valid WebP file: ${path}`);
  }

  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  let hasImage = false;
  while (offset + 8 <= bytes.length) {
    const chunkType = readAscii(bytes, offset);
    const chunkSize = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset + 4,
      4,
    ).getUint32(0, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) {
      fail(`Avatar has an invalid WebP chunk: ${path}`);
    }

    if (chunkType === 'VP8X') {
      if (chunkSize < 10) fail(`Avatar has invalid WebP dimensions: ${path}`);
      dimensions ??= {
        width: readUint24LE(bytes, dataStart + 4) + 1,
        height: readUint24LE(bytes, dataStart + 7) + 1,
      };
    } else if (chunkType === 'VP8L') {
      if (chunkSize < 6 || bytes[dataStart] !== 0x2f) {
        fail(`Avatar has an invalid WebP lossless frame: ${path}`);
      }
      dimensions ??= {
        width:
          1 +
          ((bytes[dataStart + 1] | (bytes[dataStart + 2] << 8)) & 0x3fff),
        height:
          1 +
          ((bytes[dataStart + 3] | (bytes[dataStart + 4] << 8)) & 0x3fff),
      };
      hasImage = true;
    } else if (chunkType === 'VP8 ') {
      if (
        chunkSize < 14 ||
        bytes[dataStart + 6] !== 0x9d ||
        bytes[dataStart + 7] !== 0x01 ||
        bytes[dataStart + 8] !== 0x2a
      ) {
        fail(`Avatar has an invalid WebP lossy frame: ${path}`);
      }
      dimensions ??= {
        width:
          new DataView(bytes.buffer, bytes.byteOffset + dataStart + 10, 2).getUint16(0, true) &
          0x3fff,
        height:
          new DataView(bytes.buffer, bytes.byteOffset + dataStart + 12, 2).getUint16(0, true) &
          0x3fff,
      };
      hasImage = true;
    } else if (chunkType === 'ANMF') {
      hasImage = true;
    }
    offset = dataEnd + (chunkSize % 2);
  }

  if (offset !== bytes.length || !dimensions || !hasImage) {
    fail(`Avatar must contain a WebP image: ${path}`);
  }
  return dimensions;
}

function validateAvatar(bytes: Uint8Array, path: string): void {
  const { width, height } = avatarDimensions(bytes, path);
  if (width !== height) {
    fail(`Avatar must be square (${width}x${height}): ${path}`);
  }
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
  return readSourceBundlesFor(packagesRoot, parseBundle, createMarketplaceRegistryEntry);
}

export async function readV3SourceBundles(
  packagesRoot: string,
): Promise<V3SourceBundle[]> {
  return readSourceBundlesFor(
    packagesRoot,
    parseV3Bundle,
    createMarketplaceRegistryEntryV3,
  );
}

async function readSourceBundlesFor<E extends { readonly id: string }>(
  packagesRoot: string,
  parse: (value: unknown, path: string) => MarketplacePackageBundle,
  createEntry: (bundle: MarketplacePackageBundle) => E,
): Promise<Array<GenericSourceBundle<E>>> {
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

  const sourceFiles = new Set(packageFiles);
  for (const packagePath of packageFiles) {
    const avatarPath = resolve(packagePath, '..', 'avatar.webp');
    if (files.includes(avatarPath)) sourceFiles.add(avatarPath);
  }
  const unexpectedFiles = files.filter((path) => !sourceFiles.has(path));
  if (unexpectedFiles.length > 0) {
    fail(`Unexpected source file in marketplace package tree: ${unexpectedFiles[0]}`);
  }

  const seen = new Set<string>();
  const bundles: Array<GenericSourceBundle<E>> = [];
  for (const path of packageFiles.sort()) {
    const bundle = parse(await readJson(path), path);
    validateSourceIdentity(bundle, path, packagesRoot);
    const key = `${bundle.manifest.id}@${bundle.manifest.version}`;
    if (seen.has(key)) {
      fail(`Duplicate marketplace bundle ${key}`);
    }
    seen.add(key);
    const avatarPath = resolve(path, '..', 'avatar.webp');
    if (files.includes(avatarPath)) {
      validateAvatar(await readFile(avatarPath), avatarPath);
    }
    const entry = createEntry(bundle);
    bundles.push({
      path,
      relativePath: relative(packagesRoot, path).split(sep).join('/'),
      bundle,
      entry,
      ...(files.includes(avatarPath) ? { avatarPath } : {}),
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

export function makeRegistryIndexV3(
  entries: readonly MarketplaceRegistryEntryV3[],
  catalog?: RegistryCatalog,
): MarketplaceRegistryIndexV3 {
  const permanentRetirements = createMarketplaceRegistryIndexV3([]).retirements;
  const retirements: MarketplaceRegistryRetirement[] = [
    ...permanentRetirements,
    ...(catalog
      ? [...retiredCatalogIds(catalog)].map((id) => ({ id }))
      : []),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const retiredIds = new Set(retirements.map(({ id }) => id));
  return createMarketplaceRegistryIndexV3(
    entries.filter((entry) => !retiredIds.has(entry.id)),
    retirements,
  );
}

async function writeCanonicalJson(path: string, value: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${value}\n`, 'utf8');
}

async function writeImmutableArtifact(
  path: string,
  value: string,
  registryVersion = 'v2',
): Promise<void> {
  const canonical = `${value}\n`;
  try {
    const existing = await readFile(path, 'utf8');
    if (existing !== canonical) {
      fail(`Published ${registryVersion} artifact differs from its immutable source bundle: ${path}`);
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, canonical, 'utf8');
  }
}

async function writeImmutableBinaryArtifact(
  path: string,
  value: Uint8Array,
  registryVersion = 'v2',
): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(value))) {
      fail(`Published ${registryVersion} artifact differs from its immutable source avatar: ${path}`);
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, value);
  }
}

function avatarArtifactPath(artifactPath: string): string {
  return artifactPath.replace(/\.json$/, '.webp');
}

export async function buildRegistry(root = process.cwd()): Promise<MarketplaceRegistryIndex> {
  const paths = registryPaths(root);
  const bundles = await readSourceBundles(paths.v2Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogContainsSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
  const index = makeRegistryIndex(bundles.map((bundle) => bundle.entry), catalog);

  await mkdir(paths.output, { recursive: true });
  for (const source of bundles) {
    const artifactPath = resolve(paths.output, source.entry.artifactPath);
    await writeImmutableArtifact(
      artifactPath,
      canonicalizeMarketplaceBundle(source.bundle),
    );
    if (source.avatarPath) {
      await writeImmutableBinaryArtifact(
        resolve(paths.output, avatarArtifactPath(source.entry.artifactPath)),
        await readFile(source.avatarPath),
      );
    }
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

export async function buildV3Registry(
  root = process.cwd(),
): Promise<MarketplaceRegistryIndexV3> {
  const paths = registryPaths(root);
  const bundles = await readV3SourceBundles(paths.v3Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogContainsSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
  const index = makeRegistryIndexV3(bundles.map((bundle) => bundle.entry), catalog);

  await mkdir(paths.v3Output, { recursive: true });
  for (const source of bundles) {
    const artifactPath = resolve(paths.v3Output, source.entry.artifactPath);
    await writeImmutableArtifact(
      artifactPath,
      canonicalizeMarketplaceBundle(source.bundle),
      'v3',
    );
    if (source.avatarPath) {
      await writeImmutableBinaryArtifact(
        resolve(paths.v3Output, avatarArtifactPath(source.entry.artifactPath)),
        await readFile(source.avatarPath),
        'v3',
      );
    }
  }
  await writeCanonicalJson(
    resolve(paths.v3Output, 'index.json'),
    canonicalizeMarketplaceValue(index),
  );
  await writeFile(
    resolve(paths.v3Output, 'catalog.json'),
    canonicalizeRegistryCatalog(catalog),
    'utf8',
  );
  return index;
}

export async function buildAllRegistries(root = process.cwd()): Promise<void> {
  await validateAllCatalogSourceIds(root);
  await buildRegistry(root);
  await buildV3Registry(root);
}

async function validateAllCatalogSourceIds(root: string): Promise<void> {
  const paths = registryPaths(root);
  const v2Bundles = await readSourceBundles(paths.v2Packages);
  const v3Bundles = await readV3SourceBundles(paths.v3Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogSourceIds(catalog, [
    ...v2Bundles.map((bundle) => bundle.entry.id),
    ...v3Bundles.map((bundle) => bundle.entry.id),
  ]);
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
  const expectedArtifacts = new Map<string, SourceBundle>();
  for (const source of bundles) {
    expectedArtifacts.set(source.entry.artifactPath, source);
    if (source.avatarPath) {
      expectedArtifacts.set(avatarArtifactPath(source.entry.artifactPath), source);
    }
  }
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

  for (const source of bundles) {
    if (!source.avatarPath) continue;
    const sourceAvatar = await readFile(source.avatarPath);
    const artifactPath = resolve(
      paths.output,
      avatarArtifactPath(source.entry.artifactPath),
    );
    const artifactAvatar = await readFile(artifactPath);
    validateAvatar(artifactAvatar, artifactPath);
    if (!sourceAvatar.equals(artifactAvatar)) {
      fail(`V2 registry avatar differs from its immutable source avatar: ${source.entry.id}@${source.entry.version}`);
    }
  }
}

export async function validateRegistry(root = process.cwd()): Promise<MarketplaceRegistryIndex> {
  const paths = registryPaths(root);
  const bundles = await readSourceBundles(paths.v2Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogContainsSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
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

async function validateV3Artifacts(
  paths: RegistryPaths,
  bundles: readonly V3SourceBundle[],
  index: MarketplaceRegistryIndexV3,
): Promise<void> {
  const retiredIds = new Set(index.retirements.map((retirement) => retirement.id));
  for (const entry of index.entries) {
    if (retiredIds.has(entry.id)) {
      fail(`Retired package is present in v3 entries: ${entry.id}`);
    }
  }
  const activeBundles = bundles.filter((bundle) => !retiredIds.has(bundle.entry.id));
  const expectedEntries = new Map(
    activeBundles.map((bundle) => [bundle.entry.artifactPath, bundle]),
  );
  const expectedArtifacts = new Map<string, V3SourceBundle>();
  for (const source of bundles) {
    expectedArtifacts.set(source.entry.artifactPath, source);
    if (source.avatarPath) {
      expectedArtifacts.set(avatarArtifactPath(source.entry.artifactPath), source);
    }
  }
  const indexed = new Map(index.entries.map((entry) => [entry.artifactPath, entry]));
  if (
    expectedEntries.size !== indexed.size ||
    [...expectedEntries.keys()].some((key) => !indexed.has(key))
  ) {
    fail('dist/v3/index.json does not contain exactly the source bundle set');
  }

  let artifactFiles: string[];
  try {
    artifactFiles = await filesUnder(resolve(paths.v3Output, 'artifacts'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read v3 registry artifacts: ${detail}`);
  }
  const artifactPaths = new Set(
    artifactFiles.map((path) => relative(paths.v3Output, path).split(sep).join('/')),
  );
  if (
    artifactPaths.size !== expectedArtifacts.size ||
    [...expectedArtifacts.keys()].some((key) => !artifactPaths.has(key))
  ) {
    fail('V3 registry artifacts are stale, deleted, or unexpected');
  }

  for (const source of bundles) {
    const artifactPath = resolve(paths.v3Output, source.entry.artifactPath);
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = parseV3Bundle(await readJson(artifactPath), artifactPath);
    if (artifactText.trim() !== canonicalizeMarketplaceBundle(artifact)) {
      fail(`V3 registry artifact is not canonical: ${source.entry.artifactPath}`);
    }
    validateMarketplaceRegistryEntryV3(source.entry, artifact);
    if (retiredIds.has(source.entry.id)) continue;
    const entry = indexed.get(source.entry.artifactPath);
    if (!entry) fail(`Missing v3 registry entry ${source.entry.id}@${source.entry.version}`);
    validateMarketplaceRegistryEntryV3(entry, artifact);
  }

  for (const source of bundles) {
    if (!source.avatarPath) continue;
    const sourceAvatar = await readFile(source.avatarPath);
    const artifactPath = resolve(
      paths.v3Output,
      avatarArtifactPath(source.entry.artifactPath),
    );
    const artifactAvatar = await readFile(artifactPath);
    validateAvatar(artifactAvatar, artifactPath);
    if (!sourceAvatar.equals(artifactAvatar)) {
      fail(`V3 registry avatar differs from its immutable source avatar: ${source.entry.id}@${source.entry.version}`);
    }
  }
}

export async function validateV3Registry(
  root = process.cwd(),
): Promise<MarketplaceRegistryIndexV3> {
  const paths = registryPaths(root);
  const bundles = await readV3SourceBundles(paths.v3Packages);
  const catalog = await readRegistryCatalog(paths.catalog);
  validateCatalogContainsSourceIds(catalog, bundles.map((bundle) => bundle.entry.id));
  const indexPath = resolve(paths.v3Output, 'index.json');
  const index = parseMarketplaceRegistryIndexV3(await readJson(indexPath));
  const canonicalIndex = canonicalizeMarketplaceValue(index);
  const indexText = await readFile(indexPath, 'utf8');
  if (indexText.trim() !== canonicalIndex) {
    fail('dist/v3/index.json is not canonical');
  }
  const expected = makeRegistryIndexV3(bundles.map((bundle) => bundle.entry), catalog);
  if (canonicalIndex !== canonicalizeMarketplaceValue(expected)) {
    fail('dist/v3/index.json is stale or has modified registry metadata');
  }
  const catalogOutput = resolve(paths.v3Output, 'catalog.json');
  if ((await readFile(catalogOutput, 'utf8')) !== canonicalizeRegistryCatalog(catalog)) {
    fail('dist/v3/catalog.json is stale or has modified registry metadata');
  }
  await validateV3Artifacts(paths, bundles, index);
  return index;
}

export async function validateAllRegistries(root = process.cwd()): Promise<void> {
  await validateAllCatalogSourceIds(root);
  await validateRegistry(root);
  await validateV3Registry(root);
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
  const diff = gitOutput(root, [
    ...args,
    '--',
    'packages',
    'dist/v1',
    'dist/v2',
    'dist/v3',
  ]);
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
    } else if (path === 'dist/v3/index.json' || path === 'dist/v3/catalog.json') {
      if (status !== 'A' && status !== 'M') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v3/artifacts/')) {
      if (status !== 'A') violations.push(`${status} ${path}`);
    } else if (path.startsWith('dist/v3/')) {
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
  for (const version of ['v1', 'v2', 'v3']) {
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
  await validateAllRegistries(root);
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
