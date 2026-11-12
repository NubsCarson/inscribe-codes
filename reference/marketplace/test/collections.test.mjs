import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createOrdinaryMarketplace } from "../client/service.mjs";

test("collection discovery coalesces, caches and performs no chain reads", async () => {
  let requests = 0,
    chainReads = 0;
  const collection = Keypair.generate().publicKey.toBase58();
  const market = createOrdinaryMarketplace({
    connection: {
      getMultipleAccountsInfo() {
        chainReads++;
        throw Error("No chain reads for collection discovery");
      },
    },
    catalogueUrl: "https://example.invalid/market/assets",
    getWalletProvider: () => null,
    chain: "solana:devnet",
    getCollections: async () => {
      requests++;
      await new Promise((resolve) => setImmediate(resolve));
      return [{ slug: "test", collection, name: "Collection" }];
    },
  });
  const [a, b] = await Promise.all([
    market.getCollections(),
    market.getCollections(),
  ]);
  assert.equal(a, b);
  await market.getCollections();
  assert.equal(requests, 1);
  assert.equal(chainReads, 0);
  market.refresh();
  await market.getCollections();
  assert.equal(requests, 2);
  assert.equal(chainReads, 0);
  await assert.rejects(market.openCollection("unknown"), /Unknown collection/);
});
test("malformed collections fail visibly and a later retry can recover", async () => {
  let valid = false;
  const market = createOrdinaryMarketplace({
    connection: {},
    catalogueUrl: "https://example.invalid/market/assets",
    getWalletProvider: () => null,
    chain: "solana:devnet",
    getCollections: async () =>
      valid ? [] : [{ slug: "../bad", collection: "not-an-address" }],
  });
  await assert.rejects(market.getCollections(), /identity/);
  valid = true;
  assert.deepEqual(await market.getCollections(), []);
});

test("activity reuses bounded cached backend reads and rejects unknown collections without RPC", async () => {
  let reads = 0;
  const collection = Keypair.generate().publicKey.toBase58();
  const market = createOrdinaryMarketplace({
    connection: {},
    catalogueUrl: "https://example.invalid/market/assets",
    getWalletProvider: () => null,
    chain: "solana:devnet",
    getCollections: async () => [{ slug: "test", collection }],
    getActivity: async (slug, limit) => {
      assert.equal(slug, "test");
      assert.equal(limit, 30);
      reads++;
      await new Promise((r) => setImmediate(r));
      return [{ kind: "mint" }];
    },
  });
  const [a, b] = await Promise.all([
    market.getActivity("test"),
    market.getActivity("test"),
  ]);
  assert.equal(a, b);
  await market.getActivity("test");
  assert.equal(reads, 1);
  await assert.rejects(market.getActivity("other"), /Unknown collection/);
  market.refresh();
  await market.getActivity("test");
  assert.equal(reads, 2);
});
