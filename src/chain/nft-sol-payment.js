import { ComputeBudgetProgram, PublicKey, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { isLoopback } from "./nft-currency.js";
import { mintPlatformFee } from "./nft-fees.js";
import { ASSOCIATED_TOKEN, REGISTRY, TOKEN_2022, paymentAccount, readStockBalance, validateStockRegister } from "./nft-payment.js";

// Validate the selected venue against the approved route and its pool accounts on chain.
const RAYDIUM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RAYDIUM_POOL = [247, 237, 227, 245, 215, 195, 222, 70];
const WHIRLPOOL = [63, 149, 209, 12, 225, 128, 99, 9];
const SWAP_V2 = [43, 4, 237, 11, 26, 201, 30, 98];
const TWO_HOP_V2 = [186, 143, 209, 29, 254, 2, 194, 117];
const PRICE_GUARD = [250, 244, 155, 86, 165, 168, 147, 192];
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const readU64 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
const uint = (value) => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error("Invalid SOL payment quote.");
  return BigInt(value);
};

export function swapVenue(program) {
  if (program === ORCA.toBase58()) return "Orca";
  if (program === RAYDIUM.toBase58()) return "Raydium";
  return null;
}

export function assertLocalSolPayment(connection) {
  if (!isLoopback(location.hostname) || !isLoopback(new URL(connection.rpcEndpoint).hostname)) {
    throw new Error("Pay with SOL requires the local checkout and Surfpool RPC.");
  }
}

export function verifySolQuote(quote, collection) {
  const price = BigInt(collection.priceLamports);
  const due = price + mintPlatformFee(price);
  const shortfall = uint(quote.shortfallUnits);
  const maxInput = uint(quote.inputLimitLamports);
  if (!swapVenue(quote.routerProgram) || quote.currencyMint !== collection.currency.mint || uint(quote.stockDueUnits) !== due ||
      shortfall <= 0n || shortfall > due || maxInput <= 0n || maxInput > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The SOL payment quote does not match the mint.");
  }
  const router = new PublicKey(quote.routerProgram);
  const { poolAddresses, intermediateUnits } = quote;
  if (!Array.isArray(poolAddresses) || ![1, 2].includes(poolAddresses.length) ||
      poolAddresses.some(address => typeof address !== "string") || new Set(poolAddresses).size !== poolAddresses.length) {
    throw new Error("Invalid swap route.");
  }
  const pools = poolAddresses.map(address => new PublicKey(address));
  const raydiumTwoHop = router.equals(RAYDIUM) && pools.length === 2;
  const intermediate = raydiumTwoHop ? uint(intermediateUnits) : null;
  if ((intermediate !== null && intermediate <= 0n) || (!raydiumTwoHop && intermediateUnits !== undefined)) {
    throw new Error("Invalid intermediate payment amount.");
  }
  return { price, due, shortfall, maxInput, router, pools, intermediate };
}

export async function prepareSolMint(connection, bytes, quote, { buyer, asset, collection, index }) {
  assertLocalSolPayment(connection);
  const tx = VersionedTransaction.deserialize(bytes);
  if (tx.version !== 0) {
    throw new Error("Expected a local, versioned SOL payment transaction.");
  }
  const mint = new PublicKey(collection.currency.mint);
  const terms = verifySolQuote(quote, collection);
  const { price, due, shortfall } = terms;

  const addressLookupTableAccounts = await Promise.all(tx.message.addressTableLookups.map(async ({ accountKey }) => {
    const { value } = await connection.getAddressLookupTable(accountKey, { commitment: "confirmed" });
    if (!value?.isActive()) throw new Error("A SOL payment lookup table is unavailable.");
    return value;
  }));
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts });
  const register = message.instructions.at(-1);
  const guard = message.instructions.at(-2);
  const prefix = message.instructions.slice(0, -2);
  const registry = new PublicKey(collection.registry);
  if (!guard?.programId.equals(REGISTRY) || !sameBytes(guard.data.subarray(0, 8), PRICE_GUARD) ||
      guard.data.length !== 48 || !sameBytes(guard.data.subarray(8, 40), mint.toBytes()) ||
      readU64(guard.data, 40) !== price || guard.keys.length !== 1 || !guard.keys[0].pubkey.equals(registry)) {
    throw new Error("The SOL payment is missing the mint-price guard.");
  }

  const setup = await validateSwapRoute(connection, prefix, buyer, mint, terms);
  validateStockRegister({ feePayer: message.payerKey, instructions: [...setup, register] },
    { buyer, asset, collection, index });
  if (tx.message.header.numRequiredSignatures !== 3 || !tx.message.staticAccountKeys[0].equals(buyer)) {
    throw new Error("Unexpected SOL payment signers.");
  }
  const [fee, balance] = await Promise.all([
    connection.getFeeForMessage(tx.message, "confirmed"),
    readStockBalance(connection, buyer, collection.currency),
  ]);
  if (!Number.isSafeInteger(quote.feeLamports) || quote.feeLamports < 0 || fee.value !== quote.feeLamports) {
    throw new Error("The SOL payment network fee changed. Refresh the quote.");
  }
  if (due - balance !== shortfall) throw new Error("The stock balance changed. Refresh the quote.");
  return tx;
}

function accountMatches(ix, addresses) {
  return ix.keys.length === addresses.length && addresses.every((address, index) =>
    address.equals(ix.keys[index].pubkey));
}

function isAta(ix, buyer, account, mint, tokenProgram, idempotent) {
  return ix.programId.equals(ASSOCIATED_TOKEN) &&
    (idempotent ? ix.data.length === 1 && ix.data[0] === 1 : ix.data.length === 0) &&
    accountMatches(ix, [buyer, account, buyer, mint, SystemProgram.programId, tokenProgram]);
}

function poolDirection(account, input, output) {
  // Whirlpool layout has mint and vault pairs at 101/133 and 181/213.
  if (!account?.owner.equals(ORCA) || account.data.length < 245 ||
      !sameBytes(account.data.subarray(0, 8), WHIRLPOOL)) {
    throw new Error("An approved Orca pool is unavailable.");
  }
  const [mintA, vaultA, mintB, vaultB] = [101, 133, 181, 213].map(offset =>
    new PublicKey(account.data.subarray(offset, offset + 32)));
  if (mintA.equals(input) && mintB.equals(output)) return { aToB: true, inputVault: vaultA, outputVault: vaultB };
  if (mintB.equals(input) && mintA.equals(output)) return { aToB: false, inputVault: vaultB, outputVault: vaultA };
  throw new Error("The Orca pool does not trade the quoted token pair.");
}

function oracleFor(pool) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("oracle"), pool.toBytes()], ORCA)[0];
}

function classicAccount(owner, mint) {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN)[0];
}

async function validateSwapRoute(connection, prefix, buyer, mint, { shortfall, maxInput, router, pools, intermediate: units }) {
  const wrapped = classicAccount(buyer, WSOL);
  const output = paymentAccount(buyer, mint);
  const [wrappedAccount, ...poolAccounts] = await connection.getMultipleAccountsInfo([wrapped, ...pools], "confirmed");
  if (wrappedAccount) throw new Error("This checkout needs a fresh wrapped SOL account.");
  const swaps = prefix.filter(ix => ix.programId.equals(router));
  let intermediate;
  if (router.equals(ORCA)) {
    validateOrcaSwap(swaps, { pools, poolAccounts, buyer, mint, shortfall, maxInput, wrapped, output });
  } else if (units !== null) {
    if (swaps.length !== 2) throw new Error("Expected two Raydium swaps.");
    intermediate = classicAccount(buyer, USDC);
    validateRaydiumSwap(swaps[0], pools[0], poolAccounts[0], buyer, WSOL, USDC, wrapped, intermediate, units, maxInput);
    validateRaydiumSwap(swaps[1], pools[1], poolAccounts[1], buyer, USDC, mint, intermediate, output, shortfall, units);
  } else {
    if (swaps.length !== 1) throw new Error("Expected one direct Raydium swap.");
    validateRaydiumSwap(swaps[0], pools[0], poolAccounts[0], buyer, WSOL, mint, wrapped, output, shortfall, maxInput);
  }

  const before = prefix.slice(0, prefix.indexOf(swaps[0]));
  const after = prefix.slice(prefix.indexOf(swaps.at(-1)) + 1);
  const wrapAccount = before.filter(ix => isAta(ix, buyer, wrapped, WSOL, TOKEN_PROGRAM, false));
  const stockAccount = before.filter(ix => isAta(ix, buyer, output, mint, TOKEN_2022, true));
  const intermediateAccount = intermediate ? before.filter(ix => isAta(ix, buyer, intermediate, USDC, TOKEN_PROGRAM, true)) : [];
  const topUp = before.filter(ix => ix.programId.equals(SystemProgram.programId));
  const sync = before.filter(ix => ix.programId.equals(TOKEN_PROGRAM) && ix.data.length === 1 &&
    ix.data[0] === 17 && accountMatches(ix, [wrapped]));
  const close = after.filter(ix => ix.programId.equals(TOKEN_PROGRAM) && ix.data.length === 1 &&
    ix.data[0] === 9 && accountMatches(ix, [wrapped, buyer, buyer]));
  if (wrapAccount.length !== 1 || stockAccount.length > 1 || intermediateAccount.length > 1 ||
      topUp.length !== 1 || sync.length !== 1 || close.length !== 1 ||
      before.indexOf(wrapAccount[0]) >= before.indexOf(topUp[0]) ||
      before.indexOf(topUp[0]) >= before.indexOf(sync[0]) ||
      SystemInstruction.decodeInstructionType(topUp[0]) !== "Transfer") {
    throw new Error("The swap requested unexpected wrapped SOL setup.");
  }
  const transfer = SystemInstruction.decodeTransfer(topUp[0]);
  if (!accountMatches(topUp[0], [buyer, wrapped]) || transfer.lamports !== maxInput) {
    throw new Error("The swap’s SOL funding differs from the reviewed limit.");
  }
  const compute = prefix.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId));
  if (compute.some(ix => ix.keys.length)) throw new Error("Unexpected swap compute accounts.");
  const known = new Set([...swaps, ...wrapAccount, ...stockAccount, ...intermediateAccount, ...topUp, ...sync, ...close, ...compute]);
  return prefix.filter(ix => !known.has(ix));
}

function validateOrcaSwap(swaps, { pools, poolAccounts, buyer, mint, shortfall, maxInput, wrapped, output }) {
  const twoHop = pools.length === 2;
  const swap = swaps[0];
  if (swaps.length !== 1 || swap.data.length !== (twoHop ? 60 : 43) ||
      !sameBytes(swap.data.subarray(0, 8), twoHop ? TWO_HOP_V2 : SWAP_V2) ||
      readU64(swap.data, 8) !== shortfall || readU64(swap.data, 16) !== maxInput) {
    throw new Error("The Orca swap differs from the exact output or maximum SOL shown.");
  }

  const first = poolDirection(poolAccounts[0], WSOL, twoHop ? USDC : mint);
  if (twoHop) {
    const second = poolDirection(poolAccounts[1], USDC, mint);
    const expected = [
      pools[0], pools[1], WSOL, USDC, mint, TOKEN_PROGRAM, TOKEN_PROGRAM, TOKEN_2022, wrapped,
      first.inputVault, first.outputVault, second.inputVault, second.outputVault, output, buyer,
    ];
    if (swap.data[24] !== 0 || swap.data[25] !== Number(first.aToB) || swap.data[26] !== Number(second.aToB) ||
        swap.data.subarray(27).some(Boolean) || swap.keys.length !== 24 ||
        !expected.every((key, index) => key.equals(swap.keys[index].pubkey)) || !swap.keys[14].isSigner ||
        !swap.keys[21].pubkey.equals(oracleFor(pools[0])) || !swap.keys[22].pubkey.equals(oracleFor(pools[1])) ||
        !swap.keys[23].pubkey.equals(MEMO)) {
      throw new Error("The Orca swap uses unexpected intermediate accounts or settings.");
    }
  } else {
    const expected = [
      first.aToB ? TOKEN_PROGRAM : TOKEN_2022, first.aToB ? TOKEN_2022 : TOKEN_PROGRAM, MEMO,
      buyer, pools[0], first.aToB ? WSOL : mint, first.aToB ? mint : WSOL,
      first.aToB ? wrapped : output, first.aToB ? first.inputVault : first.outputVault,
      first.aToB ? output : wrapped, first.aToB ? first.outputVault : first.inputVault,
    ];
    if (swap.data.subarray(24, 41).some(Boolean) || swap.data[41] !== Number(first.aToB) || swap.data[42] !== 0 ||
        swap.keys.length !== 15 || !expected.every((key, index) => key.equals(swap.keys[index].pubkey)) ||
        !swap.keys[3].isSigner || !swap.keys[14].pubkey.equals(oracleFor(pools[0]))) {
      throw new Error("The Orca swap uses unexpected accounts or settings.");
    }
  }

}

function validateRaydiumSwap(swap, pool, account, buyer, inputMint, outputMint, inputAccount, outputAccount, amountOut, maxInput) {
  // Raydium CLMM PoolState begins with its bump, config, creator, mints, vaults and observation.
  if (!account?.owner.equals(RAYDIUM) || account.data.length < 233 ||
      !sameBytes(account.data.subarray(0, 8), RAYDIUM_POOL)) {
    throw new Error("An approved Raydium pool is unavailable.");
  }
  const [config, mint0, mint1, vault0, vault1, observation] = [9, 73, 105, 137, 169, 201].map(offset =>
    new PublicKey(account.data.subarray(offset, offset + 32)));
  const zeroForOne = mint0.equals(inputMint) && mint1.equals(outputMint);
  if (!zeroForOne && !(mint1.equals(inputMint) && mint0.equals(outputMint))) {
    throw new Error("The Raydium pool does not trade the quoted pair.");
  }
  const expected = [buyer, config, pool, inputAccount, outputAccount, zeroForOne ? vault0 : vault1,
    zeroForOne ? vault1 : vault0, observation, TOKEN_PROGRAM, TOKEN_2022, MEMO, inputMint, outputMint];
  if (swap.data.length !== 41 || !sameBytes(swap.data.subarray(0, 8), SWAP_V2) ||
      readU64(swap.data, 8) !== amountOut || readU64(swap.data, 16) !== maxInput ||
      swap.data.subarray(24).some(Boolean) || swap.keys.length < 14 ||
      !expected.every((address, i) => address.equals(swap.keys[i].pubkey)) || !swap.keys[0].isSigner ||
      swap.keys.slice(13).some(key => key.isSigner)) {
    throw new Error("The Raydium swap differs from the reviewed output, cap or accounts.");
  }
}

export function checkedSolSignature(tx, signed) {
  if (!sameBytes(tx.message.serialize(), signed.message.serialize()) ||
      tx.signatures.length !== signed.signatures.length ||
      !signed.signatures[0].some(Boolean) ||
      !tx.signatures.slice(1).every((signature, i) => sameBytes(signature, signed.signatures[i + 1]))) {
    throw new Error("The wallet changed the reviewed SOL payment.");
  }
  return bs58.encode(signed.signatures[0]);
}

export async function recoverSolMint(connection, receipt) {
  const { value: [status] } = await connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true });
  if (status?.err) return false;
  if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) return true;
  if (status || await connection.getBlockHeight("confirmed") <= receipt.lastValidBlockHeight) {
    throw new Error("The swap and mint are still awaiting confirmation. Resume to check the receipt.");
  }
  return false;
}
