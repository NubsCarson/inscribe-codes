// Read-only seller review. The proxy supplies unsigned messages and the local
// checkout independently rebuilds the expected Tensor instruction.
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createNoopSigner } from "@solana/signers";
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS, LIST_STATE_DISCRIMINATOR, findListStatePda,
  getListStateDecoder, getListCoreInstructionAsync, getDelistCoreInstructionAsync,
} from "@tensor-foundation/marketplace";
import { apiBase, call } from "../services/nft-backend.js";

const CORE_PROGRAM = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TENSOR_PROGRAM = new PublicKey(TENSOR_MARKETPLACE_PROGRAM_ADDRESS);
const BROKER = "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1";
const LAMPORTS = 1_000_000_000n;
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export const isLocal = url => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

export function parseListingPrice(value) {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(value).trim());
  if (!match || match[1].length > 7) throw Error("Enter a SOL price with up to nine decimal places.");
  const amount = BigInt(match[1]) * LAMPORTS + BigInt((match[2] || "").padEnd(9, "0"));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Enter a positive SOL price within the supported range.");
  return amount;
}

export async function prepareSellerPreview(connection, { action, asset, collection, owner, price }) {
  if (!isLocal(location.href) || !isLocal(connection.rpcEndpoint) ||
      new URL(apiBase(), location.href).origin !== location.origin) {
    throw Error("Seller preview requires a local backend and local RPC.");
  }
  if (action !== "list" && action !== "delist") throw Error("Unsupported seller action.");
  const ownerKey = new PublicKey(owner), mint = new PublicKey(asset), collectionKey = new PublicKey(collection);
  const [stateAddress] = await findListStatePda({ mint: mint.toBase58() });
  const [core, listing] = await connection.getMultipleAccountsInfo([mint, new PublicKey(stateAddress)], "confirmed");
  if (!core?.owner.equals(CORE_PROGRAM) || core.data.length < 66 || core.data[0] !== 1 ||
      core.data[33] !== 2 || !new PublicKey(core.data.subarray(1, 33)).equals(ownerKey) ||
      !new PublicKey(core.data.subarray(34, 66)).equals(collectionKey)) {
    throw Error("The NFT owner or collection changed. Reopen the viewer.");
  }
  const signer = createNoopSigner(ownerKey.toBase58());
  const accounts = { asset: mint.toBase58(), collection: collectionKey.toBase58(), owner: signer, listState: stateAddress };
  let request = { mint: accounts.asset, owner: signer.address }, expected;
  if (action === "list") {
    if (listing) throw Error("This NFT already has an on-chain Tensor listing.");
    const amount = parseListingPrice(price);
    request = { ...request, price: Number(amount), currency: "SOL" };
    expected = await getListCoreInstructionAsync({ ...accounts, payer: signer, amount, makerBroker: BROKER });
  } else {
    if (!listing?.owner.equals(TENSOR_PROGRAM) ||
        !sameBytes(listing.data.subarray(0, 8), LIST_STATE_DISCRIMINATOR)) {
      throw Error("No verified Tensor listing found for this NFT.");
    }
    const state = getListStateDecoder().decode(listing.data);
    if (state.version !== 1 || state.assetId !== accounts.asset || state.owner !== signer.address ||
        state.currency.__option !== "None" || state.cosigner !== null) {
      throw Error("This Tensor listing is outside the SOL owner preview.");
    }
    expected = await getDelistCoreInstructionAsync({ ...accounts, rentDestination: state.rentPayer ?? signer.address });
  }

  const { status, json } = await call("/market/" + action, request);
  if (status !== 200) throw Error(json?.error || "Tensor could not prepare this transaction.");
  const bytes = typeof json?.txV0 === "string" && json.txV0.length <= 1700
    ? Uint8Array.from(atob(json.txV0), char => char.charCodeAt(0)) : null;
  if (!bytes?.length || bytes.length > 1232) throw Error("Tensor returned an invalid transaction.");
  const transaction = VersionedTransaction.deserialize(bytes);
  if (transaction.version !== 0 || transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.signatures.some(signature => signature.some(Boolean)) ||
      !transaction.message.staticAccountKeys[0].equals(ownerKey)) {
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
  // The compiler merges roles when one address fills multiple positions.
  const roles = new Map([[ownerKey.toBase58(), 3]]);
  for (const account of expected.accounts) roles.set(account.address, (roles.get(account.address) || 0) | account.role);
  if (message.instructions.length !== 1 || !ix.programId.equals(TENSOR_PROGRAM) ||
      !sameBytes(ix.data, expected.data) || ix.keys.length !== expected.accounts.length ||
      expected.accounts.some((meta, index) => {
        const key = ix.keys[index];
        const role = roles.get(meta.address);
        return key.pubkey.toBase58() !== meta.address || key.isSigner !== Boolean(role & 2) ||
          key.isWritable !== Boolean(role & 1);
      })) throw Error("The unsigned Tensor instruction does not match the requested seller action.");
  const { value: feeLamports } = await connection.getFeeForMessage(transaction.message, "confirmed");
  if (!Number.isSafeInteger(feeLamports) || feeLamports < 0) throw Error("The network fee is unavailable or the quote expired.");
  return { feeLamports };
}
