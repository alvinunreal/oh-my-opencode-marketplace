# oh-my-opencode marketplace

This repository is the GitOps source and static registry for curated
`oh-my-opencode-slim` marketplace bundles. The hosted registry URLs are:

<https://registry.ohmyopencodeslim.com/v1/>
<https://registry.ohmyopencodeslim.com/v2/>
<https://registry.ohmyopencodeslim.com/v3/>

## Contract

The registry uses the plugin's published marketplace contract, importing its
`oh-my-opencode-slim/marketplace-contract` subpath. The repository does not
copy the manifest schema, digest algorithm, summary projection, index schema,
or artifact path rules. The v1 contract's registry schema version is `1` and
its digest domain is `marketplace-bundle-v1`. The v2 contract's manifest
schema version is `2`, registry schema version is `3`, and digest domain is
`marketplace-agent-bundle-v2`. The v3 contract's manifest schema version is `3`
and digest domain is `marketplace-agent-bundle-v3`; v3 has its own index and
artifact tree.

## Contributing a package

Add one canonical source bundle at the versioned source root:

```text
packages/<publisher>/<package>/<version>/package.json
```

V2 agent bundles use the isolated migration root:

```text
packages/v2/<publisher>/<package>/<version>/package.json
```

V3 agent bundles use a separate source root and structured routing fields:

```text
packages/v3/<publisher>/<package>/<version>/package.json
```

V3 routing requires non-empty `lane`, `stats`, `delegateWhen`, and `avoid`
values. V3 extensions are append-only (`extends.promptMode` must be
`append`).

An agent version directory may also contain an optional `avatar.webp`. It must
be a square WebP image no larger than 512 KiB. The build publishes it as
immutable generated content at the matching versioned URL:

The v2 and v3 artifact paths are shown below.

Avatars are separate from the signed agent manifest and registry index. Like
the manifest, an avatar is immutable once published; publish a new version to
change it. No other files are allowed in a version directory.

The file contains the contract-defined `{ "manifest": ... }` bundle. The
publisher, package, and exact semantic version directory names must match the
manifest's `id` and `version`. Versions are immutable: publish a new version
for any change; never modify an existing version or its generated artifact.

The checked-in `dist/v1/` tree is the complete immutable v1 catalog. V2 source
bundles live separately under `packages/v2/`; its generated tree contains the
v2 index and artifacts at the exact paths defined by the contract:

```text
dist/v2/artifacts/<publisher>/<package>/<version>.json
dist/v2/artifacts/<publisher>/<package>/<version>.webp # when avatar.webp exists
```

V3 source bundles generate independent artifacts:

```text
dist/v3/artifacts/<publisher>/<package>/<version>.json
dist/v3/artifacts/<publisher>/<package>/<version>.webp # when avatar.webp exists
```

`catalog.json` is the registry-owned lifecycle control plane. Every source
package ID has exactly one entry with one of these states:

- `active`: installable and shown on the website.
- `retired`: unavailable for new installation and hidden from the website.

Retired package artifacts remain in the immutable source and generated trees,
but are absent from v2 and v3 entries. The plugin's permanent legacy retirements are
merged at build time; changes to this catalog never require a plugin release.

Use `bun run catalog:list` to inspect states or
`bun run catalog:set -- <package-id> <active|retired>` to update one before
running the normal build and validation commands.

Remote installation and web-displayed package references should use an exact
version, for example `alvin/codebase-janitor@0.1.0-beta.1`.

## Local verification

The repository pins Bun `1.3.14`, TypeScript `7.0.2`, and Wrangler `4.131.1`
for reproducible local and CI results.

```sh
bun install --frozen-lockfile
bun run build
bun run validate
bun run verify-additive
bun run verify-generated
bun test
bun run typecheck
```

`build` appends missing v2 and v3 artifacts and deterministically regenerates
both indexes; it never rewrites existing artifacts. `dist/v1/` is never removed
or rewritten. `validate` checks both v2 and v3 source identity, canonical index
and retirement ordering, complete artifact coverage, digests, and
stale/deleted/modified artifacts. `verify-additive` walks every available parent-to-child edge in
complete Git history, allowing only new package and artifact paths while
permitting index updates. `verify-generated` checks all three versioned trees,
including that v1 has not drifted. Shallow or missing history fails closed
(apart from an empty/bootstrap repository).

## Deployment

Cloudflare Workers Static Assets is configured in `wrangler.toml` and
`src/worker.ts`. A single `wrangler deploy` uploads the complete `dist/` tree
atomically. The Worker serves only
`registry.ohmyopencodeslim.com/v1/*`, `/v2/*`, and `/v3/*`, mapping each versioned root
to its assets. Versioned artifact paths receive
`max-age=31536000, immutable`; both catalogs and other registry output receive
short-lived, revalidated caching (`max-age=60`).

Deployment is deliberately manual through the `workflow_dispatch` deploy
workflow and requires the GitHub environment's Cloudflare secrets. Main and
deploy jobs share a cancel-in-progress production concurrency group, the
deploy job refreshes and verifies `origin/main` immediately before deployment,
and the post-deploy smoke check verifies the live catalog and cache headers.
The deploy operation consumes the complete `dist/` tree in one Wrangler
deployment. The smoke script uses a unique cache-busting query without
following redirects, requires HTTP 200, byte-compares both indexes and every
referenced artifact with local output, and checks both cache policies.
`bun run validate-deploy` checks Wrangler configuration without deploying. No
Cloudflare credentials are stored in this repository.
