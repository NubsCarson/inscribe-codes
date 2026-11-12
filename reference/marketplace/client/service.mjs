import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  readCoreAssetAndCollection,
  assertOrdinaryTransfer,
} from "./core-accounts.mjs";
import {
  findFeeVaultPda,
  findListStatePda,
} from "@tensor-foundation/marketplace";
import { readTensorListings } from "./tensor-market.mjs";
import { createCatalogue } from "./catalogue.mjs";
import { marketPlan, amount } from "./plan.mjs";
import { simulationQuote, participantChanges } from "./quote.mjs";
import { royaltyPolicy } from "./royalties.mjs";
import {
  assertConnectionChain,
  sendWalletTransaction,
} from "./wallet-transaction.mjs";

export function createOrdinaryMarketplace({
  connection,
  catalogueUrl,
  getWalletProvider,
  chain,
  localGenesis,
  getCollections,
  getActivity,
}) {
  let catalogue = createCatalogue({ connection, url: catalogueUrl, chain });
  const scopes = new Map();
  let collectionCache,
    collectionExpires = 0,
    collectionFlight;
  async function collections() {
    if (collectionCache && Date.now() < collectionExpires)
      return collectionCache;
    if (!collectionFlight)
      collectionFlight = (async () => {
        const rows = await getCollections();
        if (!Array.isArray(rows))
          throw Error("Collection catalogue is unavailable.");
        for (const row of rows) {
          if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.slug))
            throw Error("Invalid collection identity.");
          new PublicKey(row.collection);
        }
        collectionCache = rows;
        collectionExpires = Date.now() + 20000;
        return rows;
      })().finally(() => {
        collectionFlight = null;
      });
    return collectionFlight;
  }
  async function openCollection(slug, asset) {
    if (!(await collections()).some((row) => row.slug === slug))
      throw Error("Unknown collection.");
    if (!scopes.has(slug)) {
      const url = new URL(catalogueUrl, location.href);
      url.searchParams.set("collection", slug);
      const collection = (await collections()).find(
        (row) => row.slug === slug,
      ).collection;
      scopes.set(
        slug,
        createCatalogue({ connection, url: url.href, chain, collection }),
      );
      if (scopes.size > 8) scopes.delete(scopes.keys().next().value);
    }
    catalogue = scopes.get(slug);
    await catalogue.state();
    if (asset) await catalogue.loadAsset(asset);
    return state();
  }
  const activityCache = new Map();
  async function activity(slug) {
    if (!(await collections()).some((row) => row.slug === slug))
      throw Error("Unknown collection.");
    const saved = activityCache.get(slug);
    if (saved && Date.now() < saved.expires) return saved.promise;
    const entry = { expires: Date.now() + 20000, promise: null };
    entry.promise = (async () => {
      const rows = await getActivity(slug, 30);
      if (!Array.isArray(rows) || rows.length > 30)
        throw Error("Activity is unavailable.");
      return rows;
    })().catch((error) => {
      if (activityCache.get(slug) === entry) activityCache.delete(slug);
      throw error;
    });
    activityCache.set(slug, entry);
    if (activityCache.size > 8)
      activityCache.delete(activityCache.keys().next().value);
    return entry.promise;
  }
  const pendingKey = "iq-ordinary-market-pending:" + chain;
  let actionPending = false,
    pending = null,
    notice = "",
    reviewed = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    if (
      saved &&
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(saved.signature) &&
      Number.isSafeInteger(saved.lastValidBlockHeight) &&
      saved.lastValidBlockHeight >= 0
    )
      pending = saved;
  } catch {}
  function savePending(value) {
    // Before broadcast, receipt persistence is mandatory; an inaccessible
    // browser store must not leave an untracked trade after a reload.
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey);
    pending = value;
  }
  const address = () => getWalletProvider()?.publicKey?.toBase58() ?? null;
  const assertWallet = (provider, owner) => {
    if (getWalletProvider() !== provider || address() !== owner)
      throw Error("Wallet changed. Review again.");
  };
  async function reconcile() {
    if (!pending) return;
    const status = (
      await connection.getSignatureStatuses([pending.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) {
      notice = "Transaction failed. " + pending.signature;
      savePending(null);
      catalogue.invalidate();
      activityCache.clear();
    } else if (
      ["confirmed", "finalized"].includes(status?.confirmationStatus)
    ) {
      notice = "Confirmed. " + pending.signature;
      savePending(null);
      catalogue.invalidate();
      activityCache.clear();
    } else if (
      !status &&
      (await connection.getBlockHeight("confirmed")) >
        pending.lastValidBlockHeight
    ) {
      notice =
        "Transaction expired without confirmation. Review again before retrying.";
      savePending(null);
      catalogue.invalidate();
      activityCache.clear();
    }
  }
  async function prepare(request, provider, owner) {
    await assertConnectionChain(connection, chain, localGenesis);
    assertWallet(provider, owner);
    const known =
      catalogue.getLoadedAsset(request.asset) ||
      (await catalogue.state()).assets.find(
        (asset) => asset.asset === request.asset,
      );
    if (!known) throw Error("Load this NFT in the marketplace before trading.");
    const { asset, collection } = await readCoreAssetAndCollection(
      connection,
      known.asset,
      known.collection,
    );
    assertWallet(provider, owner);
    if (
      asset.updateAuthority?.type !== "Collection" ||
      String(asset.updateAuthority.address) !== known.collection
    )
      throw Error("NFT collection changed. Refresh the marketplace.");
    assertOrdinaryTransfer(asset, collection);
    const policy = royaltyPolicy(asset, collection);
    if (request.action === "list" && String(asset.owner) !== owner)
      throw Error("This wallet does not own the NFT.");
    const plan = await marketPlan({
      connection,
      asset: known.asset,
      collection: known.collection,
      actor: owner,
      action: request.action,
      price: request.price,
      expiresInSeconds: request.expiresInSeconds,
      creators: policy.creators,
      royaltyBasisPoints: policy.basisPoints,
    });
    assertWallet(provider, owner);
    const sellerIsCreator =
      request.action === "buy" && policy.creators.includes(plan.listing.seller);
    if (request.action === "buy" && policy.creators.includes(owner))
      throw Error(
        "A buyer who is also a royalty recipient is not supported yet.",
      );
    if (sellerIsCreator && policy.creators.length !== 1)
      throw Error(
        "Seller royalties with multiple recipients are not supported yet.",
      );
    const [listAddress] = await findListStatePda({ mint: known.asset }),
      [vault] = await findFeeVaultPda({ address: listAddress });
    const addresses = [
      ...new Set([
        owner,
        vault,
        ...policy.creators,
        ...(request.action === "buy" ? [plan.listing.seller] : []),
      ]),
    ];
    const validity = await connection.getLatestBlockhash("confirmed");
    plan.transaction.feePayer = new PublicKey(owner);
    plan.transaction.recentBlockhash = validity.blockhash;
    const fee = (
      await connection.getFeeForMessage(
        plan.transaction.compileMessage(),
        "confirmed",
      )
    ).value;
    if (!Number.isSafeInteger(fee) || fee < 0)
      throw Error("Network fee unavailable.");
    const before = await connection.getMultipleAccountsInfo(
      addresses.map((a) => new PublicKey(a)),
      "confirmed",
    );
    const simulation = await connection.simulateTransaction(
      VersionedTransaction.deserialize(
        plan.transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      ),
      {
        sigVerify: false,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses },
      },
    );
    assertWallet(provider, owner);
    if (simulation.value.err)
      throw Error(
        "Transaction simulation rejected: " +
          JSON.stringify(simulation.value.err),
      );
    const changes = participantChanges({
      addresses,
      messageKeys: new Set(
        plan.transaction.compileMessage().accountKeys.map((k) => k.toBase58()),
      ),
      before,
      after: simulation.value.accounts,
    });
    let sellerSale;
    const royaltyDelta =
      request.action !== "buy"
        ? 0n
        : sellerIsCreator
          ? (plan.price * BigInt(policy.basisPoints)) / 10000n
          : policy.creators.reduce(
              (total, address) => total + changes.get(address),
              0n,
            );
    if (request.action === "buy") {
      const listed = await connection.getAccountInfo(
        new PublicKey(plan.listing.address),
        "confirmed",
      );
      if (!listed) throw Error("Listing disappeared.");
      sellerSale =
        changes.get(plan.listing.seller) -
        BigInt(listed.lamports) -
        (sellerIsCreator ? royaltyDelta : 0n);
    }
    const quote = simulationQuote({
      action: request.action,
      price: plan.price,
      fee: BigInt(fee),
      delta: -changes.get(owner),
      vaultDelta: changes.get(vault),
      royaltyDelta,
      sellerSale,
    });
    return { plan, quote };
  }
  async function quote(request) {
    await reconcile();
    if (pending) throw Error("Wait for the pending transaction.");
    const provider = getWalletProvider(),
      owner = address();
    if (!owner) throw Error("Connect your wallet.");
    const value = await prepare(request, provider, owner);
    reviewed = { request: { ...request }, provider, owner, quote: value.quote };
    return value.quote;
  }
  async function execute(action, request) {
    if (actionPending) throw Error("Another trade is in progress.");
    actionPending = true;
    try {
      await reconcile();
      if (pending) throw Error("Wait for the pending transaction.");
      const provider = getWalletProvider(),
        owner = address(),
        input = { ...request, action };
      if (
        !reviewed ||
        reviewed.provider !== provider ||
        reviewed.owner !== owner ||
        reviewed.request.asset !== request.asset ||
        reviewed.request.action !== action ||
        (action === "list" &&
          (reviewed.request.price !== request.price ||
            reviewed.request.expiresInSeconds !== request.expiresInSeconds))
      )
        throw Error("Review this trade before signing.");
      const prepared = await prepare(input, provider, owner);
      if (JSON.stringify(prepared.quote) !== JSON.stringify(reviewed.quote))
        throw Error("Price or fees changed. Review again.");
      if (
        action === "buy" &&
        BigInt(prepared.quote.totalLamports) > amount(request.maximumAmount)
      )
        throw Error("Purchase exceeds the reviewed total.");
      const account = {
        address: owner,
        publicKey: new PublicKey(owner).toBytes(),
        chains: [chain],
        features: ["solana:signTransaction"],
      };
      const wallet = {
        chains: [chain],
        get accounts() {
          return address() === owner ? [account] : [];
        },
        features: {
          "solana:signTransaction": {
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }) => {
              assertWallet(provider, owner);
              const signed = await provider.signTransaction(
                Transaction.from(transaction),
              );
              assertWallet(provider, owner);
              return [
                { signedTransaction: new Uint8Array(signed.serialize()) },
              ];
            },
          },
        },
      };
      const signature = await sendWalletTransaction({
        connection,
        wallet,
        account,
        chain,
        localGenesis,
        transaction: prepared.plan.transaction,
        beforeSubmit: async (record) => {
          assertWallet(provider, owner);
          savePending({ ...record, asset: request.asset });
        },
      });
      savePending(null);
      notice = "Confirmed. " + signature;
      activityCache.clear();
      await catalogue
        .refreshAsset(request.asset)
        .catch(() => catalogue.invalidate());
      return { status: "confirmed", signature };
    } catch (error) {
      if (error.signature && !pending)
        throw Error(
          "Submission receipt was not saved; inspect " +
            error.signature +
            " before retrying.",
        );
      if (pending) return { status: "pending", signature: pending.signature };
      throw error;
    } finally {
      actionPending = false;
    }
  }
  async function state() {
    await reconcile();
    return { ...(await catalogue.state()), pending, transactionNotice: notice };
  }
  return {
    networkLabel:
      chain === "solana:localnet"
        ? "Local test network"
        : chain === "solana:devnet"
          ? "Solana Devnet"
          : "Solana Mainnet",
    currentWallet: address,
    ...(getActivity ? { getActivity: activity } : {}),
    async getListing(asset) {
      await assertConnectionChain(connection, chain, localGenesis);
      return (await readTensorListings(connection, [asset]))[0] ?? null;
    },
    ...(getCollections ? { getCollections: collections, openCollection } : {}),
    state,
    loadMore: () => catalogue.loadMore(),
    refresh: () => {
      catalogue.invalidate();
      collectionExpires = 0;
      activityCache.clear();
    },
    quote,
    list: (r) => execute("list", r),
    cancel: (r) => execute("cancel", r),
    buy: (r) => execute("buy", r),
  };
}
