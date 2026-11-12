import { PublicKey } from "@solana/web3.js";
import { readTensorListings } from "./tensor-market.mjs";
import { currentCoreOwners } from "./core-accounts.mjs";

// One cached backend page and two bounded account batches per explicit page load.
export function createCatalogue({ connection, url, chain, collection }) {
  let expires = 0,
    flight = null,
    snapshot = null,
    rows = [],
    cursor = null;
  async function verifyAssets(assets) {
    const [current, listings] = await Promise.all([
      currentCoreOwners(connection, assets),
      readTensorListings(
        connection,
        assets.map((asset) => asset.asset),
      ),
    ]);
    return {
      assets: current,
      listings: listings.map((listing) => ({
        ...listing,
        price: String(listing.price),
        expiry: Number(listing.expiry),
      })),
    };
  }
  async function page(after, reset, assetAddress) {
    const target = new URL(url, location.href);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw Error("Invalid marketplace API.");
    target.searchParams.set("limit", assetAddress ? "1" : "64");
    if (assetAddress) target.searchParams.set("asset", assetAddress);
    if (after) target.searchParams.set("cursor", after);
    const response = await fetch(target, { credentials: "omit" });
    if (!response.ok)
      throw Error("Marketplace catalogue is unavailable. Try again.");
    const body = await response.json();
    const expected =
      chain === "solana:localnet"
        ? "localnet"
        : chain === "solana:devnet"
          ? "devnet"
          : "mainnet";
    if (body.cluster !== expected)
      throw Error(
        "Marketplace API network does not match your wallet network.",
      );
    if (
      !Array.isArray(body.assets) ||
      body.assets.length > 64 ||
      !(body.nextCursor === null || typeof body.nextCursor === "string")
    )
      throw Error("Invalid bounded marketplace page.");
    const rawAssets = body.assets.map((a) => ({
      ...a,
      asset: new PublicKey(a.asset).toBase58(),
      collection: new PublicKey(a.collection).toBase58(),
    }));
    if (
      collection &&
      rawAssets.some((asset) => asset.collection !== collection)
    )
      throw Error("Marketplace collection mismatch.");
    if (
      assetAddress &&
      (rawAssets.length !== 1 || rawAssets[0].asset !== assetAddress)
    )
      throw Error("NFT is not in this collection catalogue.");
    if (body.nextCursor && body.nextCursor === after)
      throw Error("Marketplace page did not advance.");
    const { assets, listings } = await verifyAssets(rawAssets);
    const nextRows = reset
      ? assets
      : [...new Map([...rows, ...assets].map((a) => [a.asset, a])).values()];
    const refreshed = new Set(assets.map((asset) => asset.asset));
    const previous = reset
      ? []
      : (snapshot?.listings ?? []).filter(
          (listing) => !refreshed.has(listing.asset),
        );
    rows = nextRows;
    if (!assetAddress) cursor = body.nextCursor;
    snapshot = {
      assets: rows,
      listings: [
        ...new Map(
          [...previous, ...listings].map((listing) => [listing.asset, listing]),
        ).values(),
      ],
      nextCursor: cursor,
      networkLabel:
        expected === "localnet"
          ? "Local test network"
          : expected === "devnet"
            ? "Solana Devnet"
            : "Solana Mainnet",
    };
    expires = Date.now() + 20000;
    return snapshot;
  }
  return {
    async state() {
      if (snapshot && Date.now() < expires) return snapshot;
      if (!flight)
        flight = page(null, true).finally(() => {
          flight = null;
        });
      return flight;
    },
    async loadMore() {
      if (flight) return flight;
      if (!cursor) return snapshot;
      flight = page(cursor, false).finally(() => {
        flight = null;
      });
      return flight;
    },
    async loadAsset(address) {
      if (flight) await flight;
      if (!rows.some((asset) => asset.asset === address)) {
        flight = page(null, false, new PublicKey(address).toBase58()).finally(
          () => {
            flight = null;
          },
        );
        await flight;
      }
    },
    getLoadedAsset(address) {
      return rows.find((asset) => asset.asset === address) ?? null;
    },
    async refreshAsset(address) {
      if (flight) await flight;
      const known = rows.find((asset) => asset.asset === address);
      if (!known) {
        expires = 0;
        return;
      }
      const changed = await verifyAssets([known]);
      rows = rows.map((asset) =>
        asset.asset === address ? changed.assets[0] : asset,
      );
      snapshot = {
        ...snapshot,
        assets: rows,
        listings: [
          ...snapshot.listings.filter((listing) => listing.asset !== address),
          ...changed.listings,
        ],
      };
      expires = Date.now() + 20000;
    },
    invalidate() {
      expires = 0;
    },
  };
}
