// The mint engine for inscription NFTs (collection flow + 1/1 singles).
//
// The user signs ONE funding transfer; the reused burner then does everything
// with no further popups: pays the deposit, inscribes the item image (C),
// inscribes the canonical metadata (M), and lands the backend-co-signed
// register. Leftover sweeps back. Every step is checkpointed to localStorage so
// an interrupted mint resumes without re-paying.
//
// Contract with the backend (verified against its mint-e2e):
//   C = feed row {kind:"image", body:"data:<mime>;base64,<bytes>", who:<wallet>}
//       written with the user's inventory PDA referenced, exactly like a post.
//   M = writer.codeIn of the backend's /json body, inscribed verbatim.
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { writer } from "@iqlabs-official/solana-sdk";
import { estimateCost, getAccountRent, topUp, sweep, confirmOrCheck } from "./burner.js";
import { writeFeedRow } from "./feed.js";
import { call, collection as getCollection } from "../services/nft-backend.js";
import { notify, imgUrl } from "../services/gateway.js";
import { mintPlatformFee } from "./nft-fees.js";
import { isStockCurrency } from "./nft-currency.js";

// One popup funds the whole mint, so the budget is generous and the remainder
// sweeps back: price (including any deposit) + platform fee + register-time
// rents + both inscriptions at their caps.
const ASSET_OVERHEAD = 12_000_000; // Core asset + record rent + register fee, swept back
const IMAGE_CAP_BYTES = 256 * 1024;
const META_CAP_BYTES = 4096;

export function mintBudget(col, accountRent) {
  const stock = isStockCurrency(col.currency);
  const price = stock ? 0 : Number(col.priceLamports || 0);
  const fee = Number(mintPlatformFee(price));
  const imageRowBytes = Math.ceil((IMAGE_CAP_BYTES * 4) / 3) + 128; // base64 + row wrapper
  const img = estimateCost(imageRowBytes, accountRent === undefined ? {} : { accountRent }).total;
  const meta = estimateCost(META_CAP_BYTES, { accountRent: 0 }).total; // accounts exist after C
  return price + fee + (stock ? 0 : ASSET_OVERHEAD) + img + meta;
}

// ── Resume checkpoints ──────────────────────────────────────────────────────
const RKEY = (slug) => "ic_nft_mint_" + slug;
const loadProgress = (slug) => { try { return JSON.parse(localStorage.getItem(RKEY(slug)) || "null"); } catch (e) { return null; } };
const saveProgress = (slug, p) => { try { localStorage.setItem(RKEY(slug), JSON.stringify(p)); } catch (e) {} };
const clearProgress = (slug) => { try { localStorage.removeItem(RKEY(slug)); } catch (e) {} };
export const pendingMint = (slug) => loadProgress(slug);

// ── Shared helpers (also used by the deploy engine: one source) ─────────────
export function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
export const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function depositTransfer(connection, burner, treasury, lamports) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: burner.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: burner.publicKey, toPubkey: new PublicKey(treasury), lamports }),
  );
  tx.sign(burner);
  const sig = await connection.sendRawTransaction(tx.serialize());
  if (!(await confirmOrCheck(connection, sig, blockhash, lastValidBlockHeight))) throw new Error("deposit transfer was not confirmed");
  return sig;
}

async function fetchItemBytes(gatewayBase, arweaveId, sha256) {
  const res = await fetch((gatewayBase || "https://gateway.irys.xyz").replace(/\/$/, "") + "/" + arweaveId);
  if (!res.ok) throw new Error("could not fetch the item image (arweave " + res.status + ")");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha256) throw new Error("the fetched image does not match the on-chain manifest hash");
  return bytes;
}

// POST /mint, interpreting the backend's states: a co-signed tx, an already
// confirmed reservation, a transient "retry", or a terminal rejection.
async function mintCall(slug, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await call("/c/" + slug + "/mint", body);
    if (r.status === 200) {
      if (r.json.status === "confirmed") return { confirmed: true, index: r.json.index };
      return { transaction: r.json.transaction, lastValidBlockHeight: r.json.lastValidBlockHeight, index: r.json.index };
    }
    if (r.status === 503) { // chain unreadable, not a verdict: keep the reservation alive and retry
      await call("/c/" + slug + "/reserve/touch", { reservationId: body.reservationId }).catch(() => {});
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    if (r.status === 400) { clearProgress(slug); throw new Error("verification failed: " + ((r.json && r.json.reason) || "mismatch")); }
    if (r.status === 409 || r.status === 404) { clearProgress(slug); throw new Error((r.json && r.json.error) || "reservation is no longer valid; start a new mint"); }
    throw new Error((r.json && r.json.error) || "mint failed (" + r.status + ")");
  }
  throw new Error("verification is temporarily unavailable; try again in a moment");
}

async function sendRegister(connection, co, burner, asset) {
  const tx = Transaction.from(base64ToBytes(co.transaction));
  tx.partialSign(burner, asset);
  const sig = await connection.sendRawTransaction(tx.serialize());
  if (!(await confirmOrCheck(connection, sig, tx.recentBlockhash, co.lastValidBlockHeight))) throw new Error("register tx was not confirmed");
  return sig;
}

// Tell the backend the register tx landed so the grid lights the cell and the
// wallet's open-reservation count drops now, not at the next reconcile.
// 202 = the bit is not visible yet, ask again. Best-effort.
async function reportLanded(slug, reservationId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await call("/c/" + slug + "/mint/landed", { reservationId }).catch(() => null);
    if (!r || r.status !== 202) return;
    await new Promise((res) => setTimeout(res, 1500));
  }
}

// ── mint ────────────────────────────────────────────────────────────────────
// onStage(stage, extra): funding, deposit, reserve, image, metadata, register, stock-payment,
// confirming, done. onProgress drives the chunk bar for C.
export async function mint({ connection, wallet, burner, slug, collection, onStage, onProgress }) {
  const who = wallet.publicKey.toBase58();
  const burnerPk = burner.publicKey.toBase58();
  const stage = (s, x) => { try { onStage && onStage(s, x); } catch (e) {} };
  const col = collection || (await getCollection(slug));
  const payment = isStockCurrency(col.currency) ? await import("./nft-payment.js") : null;

  // A saved mint is only resumable for the same wallet+burner (the reservation
  // and the co-sign are bound to them). Otherwise start clean.
  let p = loadProgress(slug);
  if (p && (p.wallet !== who || p.burner !== burnerPk)) p = null;
  p = p || { wallet: who, burner: burnerPk };
  if (payment && !p.reservationId) await payment.checkStockPayment(connection, wallet.publicKey, col);
  const touch = () => (p.reservationId ? call("/c/" + slug + "/reserve/touch", { reservationId: p.reservationId }).catch(() => {}) : Promise.resolve());

  // 1. Fund once for the whole mint.
  if (!p.funded) {
    const accountRent = await getAccountRent(connection, burner.publicKey);
    const budget = mintBudget(col, accountRent);
    if (payment) {
      const [buyerSol, burnerSol] = await Promise.all([connection.getBalance(wallet.publicKey), connection.getBalance(burner.publicKey)]);
      if (buyerSol < Math.max(0, budget - burnerSol) + ASSET_OVERHEAD) throw new Error("Keep enough SOL in your wallet for inscription and NFT account costs.");
    }
    await topUp(connection, wallet, burner.publicKey, budget, (lamports) => stage("funding", { lamports }));
    p.funded = true; saveProgress(slug, p);
  }

  // 2. Deposit (burner -> creator treasury), then reserve an index.
  if (!p.reservationId) {
    if (Number(col.depositLamports) > 0 && !p.depositSig) {
      stage("deposit");
      p.depositSig = await depositTransfer(connection, burner, col.treasury, Number(col.depositLamports));
      saveProgress(slug, p);
    }
    stage("reserve");
    const r = await call("/c/" + slug + "/reserve", { wallet: who, burner: burnerPk, depositSig: p.depositSig || undefined });
    if (r.status !== 200) {
      if (r.status === 409) { clearProgress(slug); throw new Error("that deposit was already used; start a new mint"); }
      throw new Error((r.json && r.json.error) || "reserve failed (" + r.status + ")");
    }
    Object.assign(p, {
      reservationId: r.json.reservationId, index: r.json.index, arweaveId: r.json.arweaveId,
      imageSha256: r.json.imageSha256, imageMime: r.json.imageMime, name: r.json.name,
    });
    saveProgress(slug, p);
  }

  // 3. Image inscription C: fetch the bytes, check the manifest hash, write the
  //    exact feed row the verifier reproduces.
  if (!p.C) {
    stage("image", { index: p.index, name: p.name });
    await touch();
    const bytes = await fetchItemBytes(col.arweaveGateway, p.arweaveId, p.imageSha256);
    const row = { kind: "image", body: "data:" + p.imageMime + ";base64," + bytesToBase64(bytes), who };
    p.C = await writeFeedRow({ connection, burner, row: JSON.stringify(row), owner: wallet.publicKey, onProgress });
    saveProgress(slug, p);
    void notify(p.C, { ...row, __signer: burnerPk }, { signer: who });
  }

  // 4. Metadata inscription M: the canonical JSON from the backend, verbatim.
  if (!p.M) {
    stage("metadata");
    await touch();
    const jr = await call("/c/" + slug + "/json/" + p.index + "?c=" + p.C);
    if (jr.status !== 200) throw new Error((jr.json && jr.json.error) || "metadata json failed (" + jr.status + ")");
    p.M = await writer.codeIn({ connection, signer: burner }, jr.text, "nft-" + p.C + ".json", 0, "json");
    saveProgress(slug, p);
  }

  // 5. Register: the asset keypair is throwaway and client-held; persist it so
  //    a resume reuses the one the backend co-signed against.
  let asset;
  if (p.asset) asset = Keypair.fromSecretKey(Uint8Array.from(p.asset));
  else { asset = Keypair.generate(); p.asset = Array.from(asset.secretKey); saveProgress(slug, p); }
  stage("register");
  await touch();
  let co = await mintCall(slug, { reservationId: p.reservationId, inscriptionSig: p.C, metaSig: p.M, asset: asset.publicKey.toBase58() });

  let mintSig = null;
  if (!co.confirmed) {
    if (payment) {
      const latest = await getCollection(slug);
      if (latest.priceLamports !== col.priceLamports || latest.currency?.mint !== col.currency.mint ||
          latest.currency?.decimals !== col.currency.decimals) {
        throw new Error("The mint price changed. Reopen the collection to review the new price.");
      }
      const tx = Transaction.from(base64ToBytes(co.transaction));
      payment.validateStockRegister(tx, { buyer: wallet.publicKey, asset: asset.publicKey, collection: col, index: p.index });
      tx.partialSign(asset);
      stage("stock-payment");
      const signed = await wallet.signTransaction(tx);
      stage("confirming");
      mintSig = await connection.sendRawTransaction(signed.serialize());
      if (!(await confirmOrCheck(connection, mintSig, tx.recentBlockhash, co.lastValidBlockHeight))) throw new Error("Stock mint confirmation is pending. Resume to check its status.");
    } else {
      stage("confirming");
      for (let attempt = 0; attempt < 3; attempt++) {
        try { mintSig = await sendRegister(connection, co, burner, asset); break; }
        catch (e) {
          if (attempt >= 2) throw e;
          // Blockhash likely aged out; replay for the same reservation and asset.
          await touch();
          const fresh = await mintCall(slug, { reservationId: p.reservationId });
          if (fresh.confirmed) { mintSig = "(already landed)"; break; }
          co = fresh;
        }
      }
    }
  }

  // 6. Report the landing, sweep, clear the checkpoint, report.
  if (p.reservationId) await reportLanded(slug, p.reservationId);
  const refundLamports = await sweep(connection, burner, wallet.publicKey).catch(() => null);
  clearProgress(slug);
  const result = { slug, refundLamports, index: p.index, name: p.name, C: p.C, M: p.M, asset: asset.publicKey.toBase58(), mintSig };
  stage("done", result);
  return result;
}

// ── mintSingle ──────────────────────────────────────────────────────────────
// Turn an inscription the user already made (C, a feed row with who == wallet)
// into a 1/1 NFT in the global single collection. No reserve, no price, no
// Arweave: the content already exists on chain. Checkpointed under "single:"
// (collection slugs cannot contain ':', so no collision with mint keys).
export async function mintSingle({ connection, wallet, burner, C, name, kind, onStage }) {
  const who = wallet.publicKey.toBase58();
  const burnerPk = burner.publicKey.toBase58();
  const stage = (s, x) => { try { onStage && onStage(s, x); } catch (e) {} };
  const key = "single:" + C;

  let p = loadProgress(key);
  if (p && (p.wallet !== who || p.burner !== burnerPk)) p = null;
  p = p || { wallet: who, burner: burnerPk };

  // 1. Fund once: just the metadata inscription + the register-time rents.
  if (!p.funded) {
    stage("funding");
    const accountRent = await getAccountRent(connection, burner.publicKey);
    const meta = estimateCost(META_CAP_BYTES, { accountRent }).total;
    await topUp(connection, wallet, burner.publicKey, meta + ASSET_OVERHEAD);
    p.funded = true; saveProgress(key, p);
  }

  // 2. Build + inscribe the metadata M (must name C in attributes.inscription).
  if (!p.M) {
    stage("metadata");
    const meta = {
      name,
      image: imgUrl(C),
      external_url: "https://solscan.io/tx/" + C,
      attributes: [
        { trait_type: "inscription", value: C },
        { trait_type: "kind", value: kind || "image" },
        { trait_type: "chain", value: "solana" },
      ],
    };
    p.M = await writer.codeIn({ connection, signer: burner }, JSON.stringify(meta), "single-" + C + ".json", 0, "json");
    saveProgress(key, p);
  }

  // 3. Asset keypair (persisted so a resume reuses the co-signed one).
  let asset;
  if (p.asset) asset = Keypair.fromSecretKey(Uint8Array.from(p.asset));
  else { asset = Keypair.generate(); p.asset = Array.from(asset.secretKey); saveProgress(key, p); }

  // 4. Register (the backend verifies who == wallet + M names C, then co-signs).
  stage("register");
  const r = await call("/single/mint", { wallet: who, burner: burnerPk, inscriptionSig: C, metaSig: p.M, asset: asset.publicKey.toBase58(), name });
  if (r.status === 503) throw new Error("verification is temporarily unavailable; try again in a moment");
  if (r.status !== 200) { if (r.status === 400) clearProgress(key); throw new Error((r.json && (r.json.reason || r.json.error)) || "single mint failed (" + r.status + ")"); }

  stage("confirming");
  const mintSig = await sendRegister(connection, r.json, burner, asset);
  await sweep(connection, burner, wallet.publicKey).catch(() => {});
  clearProgress(key);
  const result = { C, M: p.M, asset: asset.publicKey.toBase58(), mintSig, name };
  stage("done", result);
  return result;
}
