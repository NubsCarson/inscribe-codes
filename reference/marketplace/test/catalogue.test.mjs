import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { PublicKey, Keypair } from "@solana/web3.js";
const asset = Keypair.generate().publicKey.toBase58(),
  collection = Keypair.generate().publicKey.toBase58(),
  other = Keypair.generate().publicKey.toBase58();
async function load() {
  let apiCalls = 0,
    rpcBatches = 0,
    now = 0,
    failure = false,
    cluster = "devnet",
    listed = false;
  const context = vm.createContext({
    URL,
    location: { href: "http://127.0.0.1/" },
    Date: { now: () => now },
    fetch: async (url) => {
      apiCalls++;
      await new Promise((r) => setImmediate(r));
      return {
        ok: !failure,
        json: async () => ({
          cluster,
          assets: [
            {
              asset: new URL(url).searchParams.has("asset") ? other : asset,
              collection,
              owner: "old-owner",
            },
          ],
          nextCursor:
            new URL(url).searchParams.has("cursor") ||
            new URL(url).searchParams.has("asset")
              ? null
              : asset,
        }),
      };
    },
  });
  const m = new vm.SourceTextModule(
    await readFile(new URL("../client/catalogue.mjs", import.meta.url), "utf8"),
    { context },
  );
  const deps = {
    "@solana/web3.js": { PublicKey },
    "./tensor-market.mjs": {
      readTensorListings: async () => {
        rpcBatches++;
        return listed ? [{ asset, price: 1n, expiry: 0n }] : [];
      },
    },
    "./core-accounts.mjs": {
      currentCoreOwners: async (c, a) => {
        rpcBatches++;
        return a.map((x) => ({ ...x, owner: "fresh-owner" }));
      },
    },
  };
  await m.link(
    (name) =>
      new vm.SyntheticModule(
        Object.keys(deps[name]),
        function () {
          for (const [k, v] of Object.entries(deps[name])) this.setExport(k, v);
        },
        { context },
      ),
  );
  await m.evaluate();
  return {
    catalogue: m.namespace.createCatalogue({
      connection: {},
      url: "http://127.0.0.1/market/assets",
      chain: "solana:devnet",
    }),
    counts: () => ({ apiCalls, rpcBatches }),
    expire: () => {
      now += 21000;
    },
    fail: () => {
      failure = true;
    },
    wrongChain: () => {
      cluster = "mainnet";
    },
    listing: (value) => {
      listed = value;
    },
  };
}
test("concurrent state reads coalesce and cached rereads cause no requests", async () => {
  const f = await load();
  const [a, b] = await Promise.all([f.catalogue.state(), f.catalogue.state()]);
  assert.equal(a, b);
  assert.equal(a.assets[0].owner, "fresh-owner");
  await f.catalogue.state();
  assert.deepEqual(f.counts(), { apiCalls: 1, rpcBatches: 2 });
  f.expire();
  await f.catalogue.state();
  assert.deepEqual(f.counts(), { apiCalls: 2, rpcBatches: 4 });
});
test("load-more advances the cursor and deduplicates overlapping asset rows", async () => {
  const f = await load();
  await f.catalogue.state();
  const next = await f.catalogue.loadMore();
  assert.equal(next.assets.length, 1);
  assert.equal(next.nextCursor, null);
  await f.catalogue.loadMore();
  assert.equal(f.counts().apiCalls, 2);
});
test("a failed refresh remains an error and can be retried, not an empty market", async () => {
  const f = await load();
  f.fail();
  await assert.rejects(f.catalogue.state(), /unavailable/);
  await assert.rejects(f.catalogue.state(), /unavailable/);
  assert.equal(f.counts().apiCalls, 2);
  assert.equal(f.counts().rpcBatches, 0);
});
test("wrong-cluster API response fails before any RPC listing/owner lookup", async () => {
  const f = await load();
  f.wrongChain();
  await assert.rejects(f.catalogue.state(), /network/);
  assert.equal(f.counts().rpcBatches, 0);
});

test("loaded metadata remains usable after TTL; post-trade refresh touches only its asset", async () => {
  const f = await load();
  const state = await f.catalogue.state();
  f.expire();
  assert.equal(
    f.catalogue.getLoadedAsset(state.assets[0].asset).asset,
    state.assets[0].asset,
  );
  assert.equal(f.counts().apiCalls, 1);
  await f.catalogue.refreshAsset(state.assets[0].asset);
  assert.equal(f.counts().apiCalls, 1);
  assert.equal(f.counts().rpcBatches, 4);
  await f.catalogue.state();
  assert.equal(f.counts().apiCalls, 1);
});

test("an overlapping page removes a listing closed since the earlier page", async () => {
  const f = await load();
  f.listing(true);
  assert.equal((await f.catalogue.state()).listings.length, 1);
  f.listing(false);
  assert.equal((await f.catalogue.loadMore()).listings.length, 0);
  assert.deepEqual(f.counts(), { apiCalls: 2, rpcBatches: 4 });
});

test("exact deep-link asset lookup coalesces, preserves pagination and refuses a mismatched response", async () => {
  const f = await load();
  await f.catalogue.state();
  await Promise.all([
    f.catalogue.loadAsset(other),
    f.catalogue.loadAsset(other),
  ]);
  const page = await f.catalogue.state();
  assert.equal(page.assets.length, 2);
  assert.equal(page.nextCursor, asset);
  assert.deepEqual(f.counts(), { apiCalls: 2, rpcBatches: 4 });
  await assert.rejects(
    f.catalogue.loadAsset(Keypair.generate().publicKey.toBase58()),
    /not in this collection/,
  );
  assert.equal(f.counts().rpcBatches, 4);
});
