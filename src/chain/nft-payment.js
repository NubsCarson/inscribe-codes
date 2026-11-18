import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PLATFORM_FEE_BPS } from "./nft-fees.js";
import { availableMintCurrencies, formatMintUnits } from "./nft-currency.js";

const REGISTRY = new PublicKey("FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu");
const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PLATFORM = new PublicKey("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");
const REGISTER_ITEM = [88, 92, 1, 145, 20, 252, 237, 209];

const paymentAccount = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN,
)[0];

export async function checkStockPayment(connection, buyer, collection) {
  const { currency, priceLamports } = collection;
  const supported = (await availableMintCurrencies()).find(item => item.mint === currency.mint);
  if (!supported || supported.decimals !== currency.decimals) throw new Error("Stock checkout is unavailable for this currency.");
  const account = paymentAccount(buyer, new PublicKey(currency.mint));
  const price = BigInt(priceLamports);
  const due = price + price * BigInt(PLATFORM_FEE_BPS) / 10_000n;
  const info = await connection.getAccountInfo(account, "confirmed");
  if (info && !info.owner.equals(TOKEN_2022)) throw new Error("The buyer's stock token account has the wrong program.");
  const token = info && (await connection.getTokenAccountBalance(account, "confirmed")).value;
  if (token && token.decimals !== currency.decimals) throw new Error("The stock token's decimals differ from the collection.");
  if (!token || BigInt(token.amount) < due) {
    throw new Error(`The wallet's ${currency.symbol} payment account needs ${formatMintUnits(due, currency.decimals)} ${currency.symbol} to mint.`);
  }
}

// Only ask the wallet to sign the registrar's expected stock-payment transaction.
export function validateStockRegister(tx, { buyer, asset, collection, index }) {
  const mint = new PublicKey(collection.currency.mint);
  const treasury = new PublicKey(collection.treasury);
  const creatorAccount = paymentAccount(treasury, mint);
  const feeAccount = paymentAccount(PLATFORM, mint);
  const register = tx.instructions.at(-1);
  const prepare = tx.instructions.slice(0, -1);
  const expected = {
    0: buyer, 1: buyer, 3: new PublicKey(collection.registry), 5: new PublicKey(collection.collection),
    7: treasury, 8: PLATFORM, 9: asset, 11: mint, 12: paymentAccount(buyer, mint),
    13: creatorAccount, 14: feeAccount, 15: TOKEN_2022, 16: SystemProgram.programId,
  };
  if (!tx.feePayer?.equals(buyer) || !register?.programId.equals(REGISTRY) ||
      register.data.length < 12 || !REGISTER_ITEM.every((byte, offset) => register.data[offset] === byte) ||
      register.data.readUInt32LE(8) !== index || register.keys.length !== 17 ||
      !register.keys[0].isSigner ||
      !Object.entries(expected).every(([i, address]) => register.keys[i].pubkey.equals(address))) {
    throw new Error("The registrar returned an unexpected stock mint transaction.");
  }
  if (prepare.length > 2 || !prepare.every(ix => {
    const owner = ix.keys[2]?.pubkey;
    if (!owner || ![treasury, PLATFORM].some(recipient => owner.equals(recipient))) return false;
    const accounts = [buyer, paymentAccount(owner, mint), owner, mint, SystemProgram.programId, TOKEN_2022];
    return ix.programId.equals(ASSOCIATED_TOKEN) && ix.data.length === 1 && ix.data[0] === 1 &&
      ix.keys.length === 6 && accounts.every((address, i) => ix.keys[i].pubkey.equals(address));
  })) throw new Error("The registrar requested unexpected stock token account setup.");
}
