# oh-my-opencode marketplace

This repository is the GitOps source and static registry for curated
`oh-my-opencode-slim` marketplace bundles. The hosted registry URL is:

<https://registry.ohmyopencodeslim.com/v1/>

## Contract

The registry uses the published, exact dependency
`oh-my-opencode-slim@3.0.0-beta.1`, importing its
`oh-my-opencode-slim/marketplace-contract` subpath. The repository does not
copy the manifest schema, digest algorithm, summary projection, index schema,
or artifact path rules. The contract's registry schema version is `1` and its
digest domain is `marketplace-bundle-v1`.

## Contributing a package

Add one canonical source bundle at:

```text
packages/<publisher>/<package>/<version>/package.json
```

The file contains the contract-defined `{ "manifest": ... }` bundle. The
publisher, package, and exact semantic version directory names must match the
manifest's `id` and `version`. Versions are immutable: publish a new version
for any change; never modify an existing version or its generated artifact.

The checked-in `dist/v1/` tree is generated output. It contains the full,
all-version `index.json` and artifacts at the exact paths defined by the
contract:

```text
dist/v1/artifacts/<publisher>/<package>/<version>.json
```

Remote installation and web-displayed package references should use an exact
version, for example `alvin/deepwork-recon@0.1.0-beta.1`.

## Local verification

The repository pins Bun `1.3.14`, TypeScript `7.0.2`, and Wrangler `4.131.1`
for reproducible local and CI results.

```sh
bun install --frozen-lockfile
bun run build
bun run validate
bun test
bun run typecheck
```

`build` regenerates `dist/v1/` deterministically from `packages/`; `validate`
checks source identity, canonical index ordering, complete artifact coverage,
digests, and stale/deleted/modified artifacts. On a pull request, the
workflow also runs `verify-additive` against `origin/main`, allowing only new
published package and artifact paths. Main and deploy CI walk every available
parent-to-child edge in complete Git history before building; shallow or
missing history fails closed (apart from an empty/bootstrap repository).
After building, CI runs
`verify-generated`; any change to checked-in `dist/v1/` fails rather than
silently repairing release input.

## Deployment

Cloudflare Workers Static Assets is configured in `wrangler.toml` and
`src/worker.ts`. A single `wrangler deploy` uploads the complete `dist/v1/`
tree atomically to the fixed route
`registry.ohmyopencodeslim.com/v1/*`. Versioned artifact paths receive
`max-age=31536000, immutable`; the catalog and other registry output receive
short-lived, revalidated caching (`max-age=60`).

Deployment is deliberately manual through the `workflow_dispatch` deploy
workflow and requires the GitHub environment's Cloudflare secrets. Main and
deploy jobs share a cancel-in-progress production concurrency group, the
deploy job refreshes and verifies `origin/main` immediately before deployment,
and the post-deploy smoke check verifies the live catalog and cache headers.
The deploy operation consumes the complete `dist/v1/` tree in one Wrangler
deployment. The smoke script uses a unique cache-busting query without
following redirects, requires HTTP 200, byte-compares the index and every
referenced artifact with local `dist/v1/`, and checks both cache policies.
`bun run validate-deploy` checks Wrangler configuration without deploying. No
Cloudflare credentials are stored in this repository.
