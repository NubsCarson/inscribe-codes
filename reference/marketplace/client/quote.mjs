// Monetary values come from participant balances in unsigned simulation.
export function simulationQuote({
  action,
  price,
  fee,
  delta,
  vaultDelta,
  royaltyDelta = 0n,
  sellerSale,
}) {
  if (vaultDelta < 0n || royaltyDelta < 0n)
    throw Error("Unexpected recipient debit in simulation");
  const protocolFee = vaultDelta;
  if (action !== "buy" && royaltyDelta !== 0n)
    throw Error("Unexpected royalty charge outside a purchase");
  const accountRent = action === "list" ? delta - fee - protocolFee : 0n;
  const rentRefund = action === "cancel" ? fee + protocolFee - delta : 0n;
  const cost = action === "cancel" ? fee + protocolFee : delta;
  if (accountRent < 0n || rentRefund < 0n || cost < 0n)
    throw Error("Simulation cannot be reconciled for this pinned fixture");
  let royaltyTreatment = "none";
  if (action === "buy") {
    const sale = sellerSale ?? (royaltyDelta === 0n ? price : null);
    if (sale === null || delta !== sale + royaltyDelta + protocolFee + fee)
      throw Error("Participant sale accounting does not reconcile");
    if (royaltyDelta > 0n) {
      if (sale === price && delta === price + royaltyDelta + protocolFee + fee)
        royaltyTreatment = "additional-to-price";
      else if (
        sale + royaltyDelta === price &&
        delta === price + protocolFee + fee
      )
        royaltyTreatment = "included-in-price";
      else throw Error("Royalty treatment has not been verified");
    }
  }
  return {
    priceLamports: price.toString(),
    networkFeeLamports: fee.toString(),
    totalLamports: cost.toString(),
    royaltyLamports: royaltyDelta.toString(),
    royaltyTreatment,
    protocolFeeLamports: protocolFee.toString(),
    accountRentLamports: accountRent.toString(),
    rentRefundLamports: rentRefund.toString(),
    balanceDeltaLamports: delta.toString(),
  };
}

// An account outside the transaction message cannot be changed by any CPI.
// Surfpool returns null for such unloaded requested accounts; that is a proven
// zero delta, not a guessed post-balance. Loaded accounts still require output.
export function participantChanges({ addresses, messageKeys, before, after }) {
  if (
    !Array.isArray(after) ||
    after.length !== addresses.length ||
    before.length !== addresses.length
  )
    throw Error("Missing participant simulation outputs");
  return new Map(
    addresses.map((address, i) => {
      const prior = before[i],
        post = after[i];
      if (prior && !Number.isSafeInteger(prior.lamports))
        throw Error("Missing exact participant pre-balance");
      if (!messageKeys.has(address)) {
        if (post && post.lamports !== (prior?.lamports ?? 0))
          throw Error("Unexpected change outside transaction message");
        return [address, 0n];
      }
      if (!post || !Number.isSafeInteger(post.lamports))
        throw Error("Missing exact loaded-account post-balance");
      return [address, BigInt(post.lamports) - BigInt(prior?.lamports ?? 0)];
    }),
  );
}
