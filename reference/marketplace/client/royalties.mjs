import { PublicKey } from "@solana/web3.js";

// Asset-level Royalties override collection royalties in MPL Core.
export function royaltyPolicy(asset, collection) {
  const plugin = asset.royalties ?? collection?.royalties;
  if (!plugin) return { basisPoints: 0, creators: [] };
  if ((plugin.ruleSet?.__kind ?? plugin.ruleSet?.type) !== "None")
    throw Error("This royalty rule set is not supported yet.");
  if (
    !Number.isInteger(plugin.basisPoints) ||
    plugin.basisPoints < 0 ||
    plugin.basisPoints > 10000
  )
    throw Error("Invalid on-chain royalty rate.");
  if (
    !Array.isArray(plugin.creators) ||
    plugin.creators.length < 1 ||
    plugin.creators.length > 5
  )
    throw Error("Unsupported royalty recipients.");
  const creators = plugin.creators.map((c) => ({
    address: new PublicKey(String(c.address)).toBase58(),
    percentage: c.percentage,
  }));
  if (
    creators.some(
      (c) =>
        !Number.isInteger(c.percentage) ||
        c.percentage < 0 ||
        c.percentage > 100,
    ) ||
    creators.reduce((n, c) => n + c.percentage, 0) !== 100 ||
    new Set(creators.map((c) => c.address)).size !== creators.length
  )
    throw Error("Invalid royalty recipients.");
  return {
    basisPoints: plugin.basisPoints,
    creators: creators.map((c) => c.address),
  };
}
