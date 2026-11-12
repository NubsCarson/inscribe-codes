import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { royaltyPolicy } from "../client/royalties.mjs";
const first = Keypair.generate().publicKey.toBase58(),
  second = Keypair.generate().publicKey.toBase58();
const plugin = (
  basisPoints,
  creators = [{ address: first, percentage: 100 }],
) => ({ basisPoints, creators, ruleSet: { __kind: "None" } });
test("absent royalties mean zero and asset-level plugin overrides collection", () => {
  assert.deepEqual(royaltyPolicy({}, {}), { basisPoints: 0, creators: [] });
  assert.deepEqual(
    royaltyPolicy({ royalties: plugin(250) }, { royalties: plugin(500) }),
    { basisPoints: 250, creators: [first] },
  );
});
test("multiple canonical on-chain recipients are preserved", () => {
  assert.deepEqual(
    royaltyPolicy(
      {},
      {
        royalties: plugin(500, [
          { address: first, percentage: 50 },
          { address: second, percentage: 50 },
        ]),
      },
    ),
    { basisPoints: 500, creators: [first, second] },
  );
});
test("unknown rules and invalid creators/rates fail closed", () => {
  for (const p of [
    plugin(-1),
    plugin(10001),
    plugin(500, []),
    plugin(500, [{ address: first, percentage: 40 }]),
    plugin(500, [
      { address: first, percentage: 50 },
      { address: first, percentage: 50 },
    ]),
    { ...plugin(500), ruleSet: { __kind: "ProgramDenyList" } },
  ])
    assert.throws(() => royaltyPolicy({ royalties: p }, {}));
});

import { assertOrdinaryTransfer } from "../client/core-accounts.mjs";
test("custom transfer hooks and trait oracles require their own guarded flow", () => {
  assert.doesNotThrow(() => assertOrdinaryTransfer({}, {}));
  assert.throws(
    () => assertOrdinaryTransfer({ oracles: [{}] }, {}),
    /custom trading flow/,
  );
  assert.throws(
    () => assertOrdinaryTransfer({}, { lifecycleHooks: [{}] }),
    /custom trading flow/,
  );
});
