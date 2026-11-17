// Build the selected launch locally with Pump's SDK. No transaction-builder
// service supplies instructions for the connected wallet to sign.
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK, creatorVaultPda, feeSharingConfigPda, getBuyV3TokenAmountFromQuoteAmount, newBondingCurve } from "@pump-fun/pump-sdk";
import { PumpAgentOffline } from "@pump-fun/agent-payments-sdk";
import BN from "bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { IQ_LAUNCH_FEE_SOL, SOL_MINT, USDC_MINT, canSetHolderRewardRate } from "./options.js";

const FEE_WALLET = new PublicKey("5eCDJGbuS1k5ELso8h6fnMVEJpjmrCHoX1sS92Txa9Rh");
// Shared frozen Pump Family table. It only compresses public account keys
// already selected by the SDK; the launch never takes instructions from it.
const LAUNCH_LOOKUP_TABLE = new PublicKey("6rZuW7Kh9C5dGENPChACcyDd6vJ1KdT5XeFVEPvYb2uW");
const SOL = new PublicKey(SOL_MINT);

export async function preparePump(connection, { pair, initialBuy, mode, creatorFee, feeShares, agentBuyback, creator }) {
  const online = new OnlinePumpSdk(connection);
  const selectedMint = pair ? new PublicKey(pair) : SOL;
  if (selectedMint.equals(SOL) || selectedMint.equals(PublicKey.default)) pair = "";
  const quoteMint = pair ? selectedMint : SOL;
  const [global, quote] = await Promise.all([
    online.fetchGlobal(), pair ? online.resolveQuoteMint(quoteMint) : null,
  ]);
  if (mode === "holders" && !global.isHolderRewardEnabled) throw new Error("Pump has disabled holder rewards.");
  if (mode === "mayhem" && (!global.mayhemModeEnabled || (quote && pair !== USDC_MINT))) {
    throw new Error("Mayhem is unavailable for this pair.");
  }
  if (creatorFee && !/^\d{1,5}$/.test(creatorFee)) {
    throw new Error("Enter the Holder Rewards rate in whole basis points.");
  }
  const creatorFeeBps = new BN(creatorFee || "0", 10);
  if (!creatorFeeBps.isZero()) {
    if (!canSetHolderRewardRate(mode, pair) || !global.creatorFeeConfigurable) {
      throw new Error("A custom Holder Rewards rate is unavailable for this mode or pair.");
    }
    if (creatorFeeBps.gt(global.maxConfigurableCreatorFeeBps)) {
      throw new Error(`Enter a Holder Rewards rate up to ${global.maxConfigurableCreatorFeeBps.toString()} bps.`);
    }
  }
  let shareholders;
  if (mode === "sharing") {
    const rows = (feeShares || "").trim().split(/\r?\n/).filter((row) => row.trim());
    shareholders = rows.map((row) => {
      const [address, bps, ...extra] = row.trim().split(/\s+/);
      if (!/^\d{1,5}$/.test(bps || "") || extra.length) throw new Error("Enter one wallet address and whole basis-point share per line.");
      const key = new PublicKey(address);
      const shareBps = Number(bps);
      if (key.equals(PublicKey.default) || shareBps <= 0) throw new Error("Enter a valid wallet and a positive share.");
      return { address: key, shareBps };
    });
    if (!shareholders.length || shareholders.length > 10 ||
        shareholders.reduce((total, share) => total + share.shareBps, 0) !== 10_000 ||
        new Set(shareholders.map(({ address }) => address.toBase58())).size !== shareholders.length) {
      throw new Error("Use 1–10 distinct wallets with shares totaling 10,000 basis points.");
    }
  }
  let buybackBps;
  if (mode === "agent") {
    if (!/^\d{1,5}$/.test(agentBuyback || "") || Number(agentBuyback) > 10_000) {
      throw new Error("Enter an agent buyback rate from 0 to 10,000 basis points.");
    }
    buybackBps = Number(agentBuyback);
  }
  const decimals = quote?.decimals ?? 9;
  const [whole, fraction = ""] = (initialBuy || "0").split(".");
  if (fraction.length > decimals) throw new Error("The initial buy has too many decimal places for this pair.");
  const quoteAmount = new BN(whole + fraction.padEnd(decimals, "0"), 10);
  if (quoteAmount.bitLength() > 64) throw new Error("The initial buy is too large.");
  const quoteControl = quote && !quoteAmount.isZero() ? await online.fetchQuoteControl() : undefined;
  const feeConfig = !quoteAmount.isZero() ? await online.fetchFeeConfig() : null;
  let bondingCurve, amount;
  if (feeConfig) {
    bondingCurve = newBondingCurve(global, quoteMint, quoteControl, creatorFeeBps, mode === "holders", quote?.pumpQuote?.curve);
    bondingCurve.creator = creator;
    bondingCurve.isMayhemMode = mode === "mayhem";
    amount = getBuyV3TokenAmountFromQuoteAmount({
      global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve,
      amount: quoteAmount, curveBaseTokenBalance: global.tokenTotalSupply,
    });
  }
  if (!quoteAmount.isZero() && amount.lten(0)) throw new Error("The initial buy is too small for this pair.");
  return {
    bondingCurve, creatorFeeBps, quoteAmount, quoteMint, quoteTokenProgram: quote?.quoteTokenProgram,
    pumpQuote: quote?.pumpQuote?.accounts, holderReward: mode === "holders", mayhemMode: mode === "mayhem",
    amount, shareholders, buybackBps,
  };
}

const PACKET_BYTES = 1232;

function packetFits(message) {
  try { return new VersionedTransaction(message).serialize().length <= PACKET_BYTES; }
  catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

async function prepareLaunchLookupTable(connection, wallet, message, tables, draft, onStep) {
  const user = wallet.publicKey;
  if (!draft.lookup) {
    const uncompressed = message.compileToV0Message(tables);
    const programs = new Set(message.instructions.map(({ programId }) => programId.toBase58()));
    const addresses = uncompressed.staticAccountKeys
      .slice(uncompressed.header.numRequiredSignatures)
      .filter((key) => !programs.has(key.toBase58()))
      .slice(0, 24);
    const recentSlot = await connection.getSlot("confirmed");
    const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: user, payer: user, recentSlot });
    const preview = new AddressLookupTableAccount({
      key, state: { authority: user, addresses, deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: recentSlot, lastExtendedSlotStartIndex: 0 },
    });
    if (!packetFits(message.compileToV0Message([...tables, preview]))) {
      throw new Error("This launch is too large even with an extra lookup table. Reduce the number of settings or fee recipients.");
    }
    const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: user, payer: user, addresses });
    const block = await connection.getLatestBlockhash();
    const setup = new VersionedTransaction(new TransactionMessage({
      payerKey: user, recentBlockhash: block.blockhash, instructions: [create, extend],
    }).compileToV0Message());
    if (!packetFits(setup.message)) throw new Error("The lookup table setup exceeds Solana's transaction limit.");
    const { value } = await connection.simulateTransaction(setup);
    if (value.err) throw new Error("Lookup table setup simulation failed: " + JSON.stringify(value.err));
    const rent = await connection.getMinimumBalanceForRentExemption(56 + addresses.length * 32);
    onStep("approve lookup table setup · " + (rent / 1e9).toFixed(5) + " SOL rent plus fees");
    const sent = await wallet.signAndSendTransaction(setup);
    draft.lookup = { key, block, signature: sent?.signature || sent, addresses };
  }
  const { key, block, signature, addresses } = draft.lookup;
  try {
    const { value } = await connection.confirmTransaction({ ...block, signature }, "confirmed");
    if (value.err) {
      draft.lookup = null;
      throw new Error(JSON.stringify(value.err));
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const { value: table } = await connection.getAddressLookupTable(key, { commitment: "confirmed" });
      if (table?.isActive() && table.state.authority?.equals(user) && table.state.addresses.length === addresses.length &&
          addresses.every((address, i) => address.equals(table.state.addresses[i])) &&
          await connection.getSlot("confirmed") > table.state.lastExtendedSlot) return table;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("Lookup table is not ready yet.");
  } catch (error) {
    throw new Error("Lookup table " + key.toBase58() + " · transaction " + signature + ": " + error.message);
  }
}

export async function launchOnPump({ connection, wallet, name, symbol, uri, terms, draft = {}, onStep }) {
  const user = wallet.publicKey;
  const mint = draft.mint ??= Keypair.generate();
  const params = { ...terms, name, symbol, uri, mint: mint.publicKey, creator: user, user };
  const instructions = [await PUMP_SDK.createV2Instruction(params)];

  if (terms.shareholders) {
    instructions.push(await PUMP_SDK.createFeeSharingConfig({ creator: user, mint: mint.publicKey, pool: null }));
    if (!terms.quoteMint.equals(SOL)) {
      const vault = creatorVaultPda(feeSharingConfigPda(mint.publicKey));
      const ata = getAssociatedTokenAddressSync(terms.quoteMint, vault, true, terms.quoteTokenProgram);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, ata, vault, terms.quoteMint, terms.quoteTokenProgram));
    }
    instructions.push(await PUMP_SDK.updateFeeSharesV2({
        authority: user, mint: mint.publicKey, currentShareholders: [user],
        newShareholders: terms.shareholders, quoteMint: terms.quoteMint,
        quoteTokenProgram: terms.quoteTokenProgram, bondingCurveComplete: false,
      }),
    );
  }
  if (terms.buybackBps !== undefined) {
    instructions.push(await PumpAgentOffline.load(mint.publicKey).create({
      authority: user, mint: mint.publicKey, agentAuthority: user, buybackBps: terms.buybackBps,
    }));
  }

  if (!terms.quoteAmount.isZero()) {
    instructions.push(...await PUMP_SDK.buyExactQuoteInV3Instructions({
      ...params, associatedUserAccountInfo: null, slippage: 0,
    }));
  }

  instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 650_000 }));
  instructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: FEE_WALLET, lamports: Math.round(IQ_LAUNCH_FEE_SOL * 1e9) }));
  const [recent, lookup] = await Promise.all([
    connection.getLatestBlockhash(),
    (terms.quoteAmount.isZero() && !terms.shareholders && terms.buybackBps === undefined) ? null : connection.getAddressLookupTable(LAUNCH_LOOKUP_TABLE),
  ]);
  let block = recent;
  const table = lookup?.value;
  const tables = table?.isActive() && !table.state.authority ? [table] : [];
  const message = new TransactionMessage({ payerKey: user, recentBlockhash: block.blockhash, instructions });
  let compiled = message.compileToV0Message(tables);
  if (!packetFits(compiled)) {
    tables.push(await prepareLaunchLookupTable(connection, wallet, message, tables, draft, onStep));
    block = await connection.getLatestBlockhash();
    message.recentBlockhash = block.blockhash;
    compiled = message.compileToV0Message(tables);
  }
  if (!packetFits(compiled)) throw new Error("The selected launch options do not fit in one Solana transaction.");
  const tx = new VersionedTransaction(compiled);
  tx.sign([mint]);
  onStep("checking the launch before wallet approval");
  const { value } = await connection.simulateTransaction(tx);
  if (value.err) throw new Error("Pump launch simulation failed: " + (value.logs?.findLast((line) => line.includes("Error Message")) || JSON.stringify(value.err)));

  onStep("approve the transaction in your wallet");
  const sent = await wallet.signAndSendTransaction(tx);
  const sig = sent?.signature || sent;
  onStep("confirming on solana");
  try {
    const { value: confirmed } = await connection.confirmTransaction({ signature: sig, ...block }, "confirmed");
    if (confirmed.err) throw new Error(JSON.stringify(confirmed.err));
  } catch (error) {
    throw new Error("Check transaction " + sig + " before retrying: " + error.message);
  }
  return { mint: mint.publicKey.toBase58(), sig, lookupTable: draft.lookup?.key.toBase58() };
}
