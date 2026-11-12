# Marketplace prototype reference

I experimented with in-site NFT trading for the earlier IQ frontend, then paused it to focus on Nubbies and the existing launchpad. Sharing these extracted modules in case any of them help with the Tensor work in [issue #1](https://github.com/IQCoreTeam/inscribe-codes/issues/1). This branch is a source reference for discussion.

## Included

- Tensor SDK list, delist and buy instruction builders, adapted to the existing web3 wallet.
- Current owner and listing checks, simulation quotes, royalty handling and transaction confirmation.
- Bounded catalogue pagination, request coalescing, collection discovery and activity cache handling.
- A SQLite catalogue reader and tests against an in-memory fixture.

The original approach builds Tensor instructions in the browser. The new plan in issue #1 uses server-side Tensor transaction endpoints. These modules illustrate the earlier approach and need an explicit integration decision and review before use in inscribe.codes.

The earlier UI and private collection artwork are omitted. No code in this directory is imported by the site.

## Local checks

From this directory:

```sh
npm ci --ignore-scripts
npm test
bun test backend/catalog.test.ts
```

On November 12, 2026, all 14 extracted client tests passed, and the backend reader passed four tests and 21 assertions. These cover catalogue paging/cache behavior, collection discovery, activity caching and royalty/transfer policy.

Earlier full-prototype records included a Surfpool purchase, ownership and activity checks. Those results are historical and do not establish a current live deployment. Final browser checks for exact-item navigation, activity cache refresh and mobile activity were still pending when the prototype was paused.

## Integration work still needed

- Adapt the client to the chosen Tensor API or instruction-building approach.
- Mount the UI into the current site and use its wallet/session handling.
- Reconcile the catalogue with the current backend schema.
- Re-run list, cancel and buy against the chosen cluster and verify fees, royalties, ownership changes and activity.
- Review supported Core plugins and custom transfer restrictions.

No merge request is intended for this reference branch. Feedback on useful pieces is welcome.
