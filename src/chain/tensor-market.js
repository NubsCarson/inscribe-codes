// Local checkout independently verifies the order, Core asset and unsigned
// transaction prepared by the Tensor proxy before requesting a wallet signature.
import { PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createNoopSigner } from "@solana/signers";
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS, LIST_STATE_DISCRIMINATOR, findListStatePda,
  getListStateDecoder, getListCoreInstructionAsync, getDelistCoreInstructionAsync, getBuyCoreInstructionAsync,
  getBuyCoreSplInstructionAsync, findFeeVaultPda,
} from "@tensor-foundation/marketplace";
import bs58 from "bs58";
import { apiBase, call } from "../services/nft-backend.js";

const CORE_PROGRAM = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TENSOR_PROGRAM = new PublicKey(TENSOR_MARKETPLACE_PROGRAM_ADDRESS);
const BROKER = "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SOL_CURRENCY = Object.freeze({ mint: "SOL", symbol: "SOL", decimals: 9 });
export const NVDAX_CURRENCY = Object.freeze({ mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", symbol: "NVDAx", decimals: 8 });

function tokenAddress(owner, currency) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), TOKEN_2022.toBytes(), new PublicKey(currency).toBytes()], ATA_PROGRAM,
  )[0].toBase58();
}

function tokenAmount(data, currency, actor) {
  if (!data || data.length < 165 || !new PublicKey(data.subarray(0, 32)).equals(new PublicKey(currency)) ||
      !new PublicKey(data.subarray(32, 64)).equals(new PublicKey(actor)) || data[108] !== 1) {
    throw Error("The buyer’s NVDAx account could not be verified.");
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const option = value => value.__option === "None" ? null : value.value;

export const isLocal = url => {
  const address = new URL(url);
  return ["http:", "https:"].includes(address.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) &&
    !address.username && !address.password;
};

function assertLocalMarket(connection) {
  if (!isLocal(location.href) || !isLocal(connection.rpcEndpoint) ||
      new URL(apiBase(), location.href).origin !== location.origin) {
    throw Error("Market checkout requires a local backend and local RPC.");
  }
}

export function parseListingPrice(value, { decimals, symbol }) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match || match[1].length > 7 || (match[2]?.length ?? 0) > decimals) {
    throw Error("Enter a " + symbol + " price with up to " + decimals + " decimal places.");
  }
  const amount = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] || "").padEnd(decimals, "0"));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Enter a positive price within the supported range.");
  return amount;
}

export async function readMarketState(connection, { asset, collection }) {
  assertLocalMarket(connection);
  const assetKey = new PublicKey(asset), collectionKey = new PublicKey(collection);
  const [order] = await findListStatePda({ mint: asset });
  const [[core, account, clock], response] = await Promise.all([
    connection.getMultipleAccountsInfo([assetKey, new PublicKey(order), SYSVAR_CLOCK_PUBKEY], "confirmed"),
    call("/market/listing/" + asset),
  ]);
  if (response.status !== 200 || !response.json) throw Error(response.json?.error || "Tensor listing verification is unavailable.");
  if (!core?.owner.equals(CORE_PROGRAM) || core.data.length < 66 || core.data[0] !== 1 ||
      core.data[33] !== 2 || !new PublicKey(core.data.subarray(34, 66)).equals(collectionKey)) {
    throw Error("The NFT or its collection changed. Reopen the viewer.");
  }
  const currentOwner = new PublicKey(core.data.subarray(1, 33)).toBase58();
  const proxy = response.json.listing;
  if (response.json.currentOwner !== currentOwner || Boolean(proxy) !== Boolean(account)) {
    throw Error("The Tensor listing changed between reads. Refresh to review again.");
  }
  if (!account) return { currentOwner, listing: null, core };
  if (!account.owner.equals(TENSOR_PROGRAM) || !clock || clock.data.length < 40 ||
      !sameBytes(account.data.subarray(0, 8), LIST_STATE_DISCRIMINATOR)) {
    throw Error("No verified Tensor listing found for this NFT.");
  }
  const state = getListStateDecoder().decode(account.data);
  if (state.version !== 1 || state.assetId !== asset || state.amount <= 0n || state.expiry < 0n) {
    throw Error("The Tensor order does not match this NFT.");
  }
  const currency = option(state.currency) ?? "SOL";
  const expired = state.expiry < new DataView(
    clock.data.buffer, clock.data.byteOffset, clock.data.byteLength,
  ).getBigInt64(32, true);
  const terms = {
    mint: asset, order, owner: state.owner, price: state.amount.toString(), currency,
    expiry: state.expiry.toString(), expired, privateTaker: option(state.privateTaker),
    makerBroker: option(state.makerBroker), rentPayer: state.rentPayer, cosigner: state.cosigner,
  };
  if (Object.entries(terms).some(([key, value]) => proxy[key] !== value)) {
    throw Error("The proxy quote does not match the verified on-chain listing.");
  }
  const isSupportedCurrency = currency === "SOL" || currency === NVDAX_CURRENCY.mint;
  const localOrder = isSupportedCurrency && !state.cosigner && currentOwner === order;
  const buySupported = localOrder && !expired && !terms.privateTaker && proxy.buySupported === true;
  const currencyInfo = currency === "SOL" ? SOL_CURRENCY
    : currency === NVDAX_CURRENCY.mint ? NVDAX_CURRENCY
    : proxy.currencyInfo?.mint === currency && /^[\w.-]{1,12}$/.test(proxy.currencyInfo.symbol) &&
      Number.isInteger(proxy.currencyInfo.decimals) && proxy.currencyInfo.decimals >= 0 && proxy.currencyInfo.decimals <= 18
      ? proxy.currencyInfo : null;
  return { currentOwner, listing: { ...terms, currencyInfo, buySupported, delistSupported: localOrder }, core };
}

async function readRoyalties(connection, asset, collection, core) {
  const { deserializeAssetV1, deserializeCollectionV1 } = await import("@metaplex-foundation/mpl-core");
  const collectionAccount = await connection.getAccountInfo(new PublicKey(collection), "confirmed");
  if (!collectionAccount?.owner.equals(CORE_PROGRAM)) throw Error("The Core collection is unavailable.");
  const raw = (publicKey, account) => ({ ...account, publicKey, owner: account.owner.toBase58(),
    data: new Uint8Array(account.data), lamports: { basisPoints: BigInt(account.lamports), identifier: "SOL", decimals: 9 } });
  const item = deserializeAssetV1(raw(asset, core));
  const series = deserializeCollectionV1(raw(collection, collectionAccount));
  if ([item, series].some(record => record.oracles?.length || record.lifecycleHooks?.length)) {
    throw Error("This NFT requires its collection’s custom trading flow.");
  }
  const plugin = item.royalties ?? series.royalties;
  if (!plugin) return { basisPoints: 0n, creators: [] };
  if ((plugin.ruleSet?.__kind ?? plugin.ruleSet?.type) !== "None" ||
      !Number.isInteger(plugin.basisPoints) || plugin.basisPoints < 0 || plugin.basisPoints > 10_000 ||
      !Array.isArray(plugin.creators) || !plugin.creators.length || plugin.creators.length > 5 ||
      plugin.creators.some(row => !Number.isInteger(row.percentage) || row.percentage < 0 || row.percentage > 100) ||
      plugin.creators.reduce((sum, row) => sum + row.percentage, 0) !== 100) {
    throw Error("This royalty configuration cannot be verified.");
  }
  const creators = plugin.creators.map(row => new PublicKey(String(row.address)).toBase58());
  if (new Set(creators).size !== creators.length) throw Error("Duplicate royalty recipients.");
  return { basisPoints: BigInt(plugin.basisPoints), creators };
}

async function transactionFromProxy(connection, actor, expected, quote) {
  const raw = typeof quote?.txV0 === "string" && quote.txV0.length <= 1700
    ? Uint8Array.from(atob(quote.txV0), char => char.charCodeAt(0)) : null;
  if (!raw?.length || raw.length > 1232) throw Error("Tensor returned an invalid transaction.");
  const transaction = VersionedTransaction.deserialize(raw);
  if (transaction.version !== 0 || transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.signatures.some(signature => signature.some(Boolean)) ||
      transaction.message.staticAccountKeys[0].toBase58() !== actor) {
    throw Error("Tensor returned an unexpected signer or transaction version.");
  }
  if (transaction.message.addressTableLookups.length > 6) throw Error("Tensor returned too many lookup tables.");
  const addressLookupTableAccounts = await Promise.all(transaction.message.addressTableLookups.map(async ({ accountKey }) => {
    const { value } = await connection.getAddressLookupTable(accountKey, { commitment: "confirmed" });
    if (!value?.isActive()) throw Error("An address lookup table is unavailable.");
    return value;
  }));
  const message = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts });
  const ix = message.instructions[0];
  // The v0 compiler combines flags for repeated accounts, including the payer.
  const roles = new Map([[actor, 3]]);
  for (const account of expected.accounts) roles.set(account.address, (roles.get(account.address) || 0) | account.role);
  if (message.instructions.length !== 1 || !ix.programId.equals(TENSOR_PROGRAM) ||
      !sameBytes(ix.data, expected.data) || ix.keys.length !== expected.accounts.length ||
      expected.accounts.some((meta, index) => {
        const key = ix.keys[index], role = roles.get(meta.address);
        return key.pubkey.toBase58() !== meta.address || key.isSigner !== Boolean(role & 2) ||
          key.isWritable !== Boolean(role & 1);
      })) throw Error("The unsigned Tensor instruction does not match the reviewed action.");
  return transaction;
}

export async function prepareMarketTrade(connection, { action, asset, collection, actor, price, currency: selectedCurrency, listing: before }) {
  const { currentOwner, listing, core } = await readMarketState(connection, { asset, collection });
  if (before?.order !== listing?.order || before?.price !== listing?.price ||
      before?.owner !== listing?.owner || before?.currency !== listing?.currency) {
    throw Error("The listed price or currency changed. Refresh to review again.");
  }
  const signer = createNoopSigner(new PublicKey(actor).toBase58());
  const accounts = { asset, collection, listState: listing?.order };
  const mintAddress = listing?.currency ?? selectedCurrency?.mint ?? SOL_CURRENCY.mint;
  const stock = mintAddress === NVDAX_CURRENCY.mint;
  if (mintAddress !== SOL_CURRENCY.mint && !stock) throw Error("This currency is unavailable for local checkout.");
  const currency = stock ? NVDAX_CURRENCY : SOL_CURRENCY;
  const tokenAccount = action === "buy" && stock ? tokenAddress(actor, currency.mint) : null;
  if (stock) {
    const mint = await connection.getAccountInfo(new PublicKey(currency.mint), "confirmed");
    if (!mint?.owner.equals(TOKEN_2022) || mint.data.length < 82 || mint.data[44] !== NVDAX_CURRENCY.decimals || mint.data[45] !== 1) {
      throw Error("The NVDAx Token-2022 mint could not be verified.");
    }
  }
  let request, expected, ask, purchaseCap;
  if (action === "list" && !listing && currentOwner === actor) {
    ask = parseListingPrice(price, currency);
    request = { mint: asset, owner: actor, price: Number(ask), currency: currency.mint };
    expected = await getListCoreInstructionAsync({ ...accounts, owner: signer, payer: signer, amount: ask, makerBroker: BROKER,
      ...(stock ? { currency: currency.mint } : {}) });
  } else if (action === "delist" && listing?.delistSupported && listing.owner === actor) {
    ask = BigInt(listing.price);
    request = { mint: asset, owner: actor };
    expected = await getDelistCoreInstructionAsync({ ...accounts, owner: signer, rentDestination: listing.rentPayer ?? actor });
  } else if (action === "buy" && listing?.buySupported && listing.owner !== actor) {
    const { basisPoints, creators } = await readRoyalties(connection, asset, collection, core);
    ask = BigInt(listing.price);
    purchaseCap = ask + ask * basisPoints / 10_000n;
    if (purchaseCap > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("The listing amount is outside the exact checkout range.");
    request = { mint: asset, buyer: actor, owner: listing.owner, maxPrice: Number(purchaseCap), currency: currency.mint };
    const buy = { ...accounts, buyer: actor, payer: signer, owner: listing.owner,
      takerBroker: BROKER, makerBroker: listing.makerBroker ?? undefined, rentDestination: listing.rentPayer ?? listing.owner,
      maxAmount: purchaseCap, creators };
    if (stock) {
      const [feeVault] = await findFeeVaultPda({ address: listing.order });
      expected = await getBuyCoreSplInstructionAsync({ ...buy, feeVault, currency: currency.mint,
        currencyTokenProgram: TOKEN_2022.toBase58(), payerCurrencyTa: tokenAccount,
        ownerCurrencyTa: tokenAddress(listing.owner, currency.mint),
        feeVaultCurrencyTa: tokenAddress(feeVault, currency.mint), takerBrokerTa: tokenAddress(BROKER, currency.mint),
        makerBrokerTa: listing.makerBroker ? tokenAddress(listing.makerBroker, currency.mint) : undefined,
        creatorsCurrencyTa: creators.map(creator => tokenAddress(creator, currency.mint)),
      });
    } else expected = await getBuyCoreInstructionAsync(buy);
  } else {
    throw Error("This wallet cannot perform that action on the verified listing.");
  }

  const { status, json } = await call("/market/" + action, request);
  if (status !== 200) throw Error(json?.error || "Tensor could not prepare this transaction.");
  const transaction = await transactionFromProxy(connection, actor, expected, json);
  const quote = await simulateTrade(connection, transaction, actor, currency.mint, tokenAccount);
  if (action === "buy" && (quote.estimatedDebitLamports < quote.feeLamports ||
      (stock && (quote.tokenDebit === null || quote.tokenDebit < purchaseCap)))) {
    throw Error("Could not verify the buyer’s total from simulation.");
  }
  return { transaction, ...quote, ask, purchaseCap, currency, tokenAccount };
}

async function simulateTrade(connection, transaction, actor, currency, tokenAccount) {
  const addresses = tokenAccount ? [actor, tokenAccount] : [actor];
  const [{ value: feeLamports }, before] = await Promise.all([
    connection.getFeeForMessage(transaction.message, "confirmed"),
    connection.getMultipleAccountsInfoAndContext(addresses.map(address => new PublicKey(address)), "confirmed"),
  ]);
  const [wallet, token] = before.value;
  if (!Number.isSafeInteger(feeLamports) || feeLamports < 0 || !Number.isSafeInteger(wallet?.lamports)) {
    throw Error("The network fee or balance is unavailable. Review the trade again.");
  }
  if (tokenAccount && !token?.owner.equals(TOKEN_2022)) throw Error("This wallet needs an NVDAx token account.");
  const priorTokens = tokenAccount ? tokenAmount(token.data, currency, actor) : null;
  const simulated = await connection.simulateTransaction(transaction, {
    commitment: "confirmed", sigVerify: false, minContextSlot: before.context.slot,
    accounts: { encoding: "base64", addresses },
  });
  const [simulatedWallet, simulatedToken] = simulated.value.accounts ?? [];
  if (simulated.value.err || !Number.isSafeInteger(simulatedWallet?.lamports) ||
      (tokenAccount && (simulatedToken?.owner !== TOKEN_2022.toBase58() || simulatedToken.data?.[1] !== "base64"))) {
    throw Error("The reviewed transaction did not pass local simulation.");
  }
  const tokenDebit = tokenAccount
    ? priorTokens - tokenAmount(Uint8Array.from(atob(simulatedToken.data[0]), c => c.charCodeAt(0)), currency, actor) : null;
  return { feeLamports, estimatedDebitLamports: wallet.lamports - simulatedWallet.lamports, tokenDebit };
}

export async function submitMarketTrade(connection, wallet, reviewed, { actor, asset, collection, genesis, listing, isCurrent }, beforeSign) {
  assertLocalMarket(connection);
  if (wallet.publicKey?.toBase58() !== actor || await connection.getGenesisHash() !== genesis) {
    throw Error("The wallet or local chain changed. Review the trade again.");
  }
  const { transaction } = reviewed;
  const key = ["ic-tensor-pending", connection.rpcEndpoint, genesis, actor, asset].join(":");
  const pending = JSON.parse(sessionStorage.getItem(key) || "null");
  if (pending) {
    const { value: [state] } = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
    if (state && !state.err && ["confirmed", "finalized"].includes(state.confirmationStatus)) {
      sessionStorage.removeItem(key);
      throw Error("The previous trade confirmed. Refresh the listing before reviewing another trade.");
    }
    if (!state?.err && (state || (await connection.isBlockhashValid(pending.blockhash, "confirmed")).value)) {
      throw Error("The previous trade is still pending. Check it before retrying.");
    }
    sessionStorage.removeItem(key);
  }
  const blockhash = transaction.message.recentBlockhash;
  if (!(await connection.isBlockhashValid(blockhash, "confirmed")).value) throw Error("The quote expired. Review the trade again.");
  const latest = await readMarketState(connection, { asset, collection });
  if (listing ? !latest.listing || Object.entries(listing).some(([field, value]) =>
      field !== "currencyInfo" && latest.listing[field] !== value)
    : latest.listing || latest.currentOwner !== actor) {
    throw Error("The listing changed. Refresh to review it again.");
  }
  const quote = await simulateTrade(connection, transaction, actor, reviewed.currency.mint, reviewed.tokenAccount);
  if (quote.feeLamports !== reviewed.feeLamports || quote.estimatedDebitLamports !== reviewed.estimatedDebitLamports ||
      quote.tokenDebit !== reviewed.tokenDebit) {
    throw Error("The estimated debit or network fee changed. Review the trade again.");
  }
  if (!isCurrent()) throw Error("The wallet or viewer changed. Review the trade again.");
  beforeSign();
  const expected = transaction.message.serialize();
  const signed = await wallet.signTransaction(transaction);
  if (!isCurrent() || wallet.publicKey?.toBase58() !== actor || signed.version !== 0 ||
      signed.signatures.length !== 1 || !signed.signatures[0].some(Boolean) ||
      !sameBytes(expected, signed.message.serialize())) throw Error("The wallet changed the reviewed transaction.");
  const signature = bs58.encode(signed.signatures[0]);
  // Persist the exact wallet signature before broadcasting a reusable review.
  sessionStorage.setItem(key, JSON.stringify({ signature, blockhash }));
  if (await connection.sendRawTransaction(signed.serialize()) !== signature) {
    throw Error("The RPC returned a different signature. Check the previous trade before retrying.");
  }
  for (let i = 0; i < 25; i++) {
    const { value: [state] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (state?.err) {
      sessionStorage.removeItem(key);
      throw Error("The reviewed trade failed on the local chain.");
    }
    if (["confirmed", "finalized"].includes(state?.confirmationStatus)) {
      sessionStorage.removeItem(key);
      return signature;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("The trade is still awaiting confirmation. Check it before retrying.");
}
