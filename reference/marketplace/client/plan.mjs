import { Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  readTensorListings,
  tensorListingInstruction,
  tensorCancelInstruction,
  tensorPurchaseInstructions,
} from "./tensor-market.mjs";
export function amount(value) {
  if (
    typeof value !== "string" ||
    !/^\d{1,20}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw Error("Invalid integer lamports");
  return BigInt(value);
}
export async function marketPlan({
  connection,
  asset,
  collection,
  actor,
  action,
  price,
  expiresInSeconds = 604800,
  creators = [],
  royaltyBasisPoints = 0,
}) {
  const listing = (await readTensorListings(connection, [asset]))[0];
  let instructions, base;
  if (action === "list") {
    if (listing)
      throw Error("An existing listing must be canceled before relisting");
    base = amount(price);
    if (base <= 0n) throw Error("Set a positive price");
    if (![86400, 604800, 2592000].includes(expiresInSeconds))
      throw Error("Invalid listing lifetime");
    instructions = [
      await tensorListingInstruction({
        asset,
        collection,
        seller: actor,
        price: base,
        expiresInSeconds,
      }),
    ];
  } else {
    if (!listing) throw Error("The listing no longer exists");
    base = listing.price;
    if (action === "cancel")
      instructions = [
        await tensorCancelInstruction({ listing, collection, seller: actor }),
      ];
    else if (action === "buy") {
      if (listing.seller === actor)
        throw Error("The seller cannot buy their own listing");
      if (
        !Number.isInteger(royaltyBasisPoints) ||
        royaltyBasisPoints < 0 ||
        royaltyBasisPoints > 10000
      )
        throw Error("Unverified royalty basis points");
      // Tensor maxAmount covers verified base+royalty, not protocol/network fees.
      const sdkMaximum =
        listing.price + (listing.price * BigInt(royaltyBasisPoints)) / 10000n;
      instructions = await tensorPurchaseInstructions({
        listing,
        collection,
        buyer: actor,
        creators,
        maximumAmount: sdkMaximum,
      });
    } else throw Error("Unknown market action");
  }
  return {
    transaction: new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
      ...instructions,
    ),
    listing,
    price: base,
  };
}
