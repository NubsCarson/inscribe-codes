import { call } from "../services/nft-backend.js";

export const SOL = { mint: "SOL", symbol: "SOL", decimals: 9 };
const SOL_SENTINEL = "11111111111111111111111111111111";

export function isStockCurrency(currency) {
  return Boolean(currency?.mint && currency.mint !== SOL.mint && currency.mint !== SOL_SENTINEL);
}

export function collectionCurrency(collection) {
  return collection.currency || (collection.chain === "robinhood" ? { symbol: "ETH", decimals: 9 } : SOL);
}

export function toMintUnits(amount, decimals) {
  const text = String(amount).trim() || "0";
  if (text.length > 34 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error("Enter a valid mint amount.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Use up to ${decimals} decimal places for this currency.`);
  const raw = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Mint amount is too large.");
  return Number(raw);
}

export function formatMintUnits(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const amount = BigInt(units || 0);
  const fraction = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (amount / base).toLocaleString("en-US") + (fraction ? "." + fraction : "");
}

export async function availableMintCurrencies() {
  const { status, json } = await call("/creator/currencies");
  if (status !== 200 || json?.checkout !== "wallet-v1" || !Array.isArray(json.currencies)) return [SOL];
  return [SOL, ...json.currencies.filter(c => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.mint || "") &&
    /^[\w.-]{1,12}$/.test(c.symbol || "") && Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 9)];
}
