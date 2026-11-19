// The creator deploy engine for an inscription NFT collection.
//
// The creator signs ONE funding transfer; the reused burner then inscribes the
// manifest and collection.json and lands the one deploy tx (createCollection +
// initialize_registry + platform fee) with no further popups. Images are
// compressed in the browser (squoosh) and uploaded to Arweave by the backend in
// small batches. Leftover sweeps back. Every step is checkpointed so an
// interrupted deploy resumes without re-paying.
import { Keypair, Transaction } from "@solana/web3.js";
import { writer } from "@iqlabs-official/solana-sdk";
import { estimateCost, getAccountRent, topUp, sweep, confirmOrCheck } from "./burner.js";
import { writeFeedRow } from "./feed.js";
import { bytesToBase64, base64ToBytes } from "./nft.js";
import { call } from "../services/nft-backend.js";
import { notify } from "../services/gateway.js";
import { compressImage } from "../ui/image.js";

// Collection account + registry (bitmap) rent + tx fees, swept back after deploy.
const DEPLOY_OVERHEAD = 15_000_000;

// Images go up this many at a time: one request stays a couple of MB and the
// server's Arweave upload for the batch finishes well under any proxy timeout.
const STAGE_BATCH = 40;
// Hand control back to the browser between images so the bar paints and the
// page stays responsive (the squoosh encode otherwise pegs the main thread).
const tick = () => new Promise((r) => setTimeout(r, 0));

const RKEY = (slug) => "ic_nft_deploy_" + slug;
const loadProgress = (slug) => { try { return JSON.parse(localStorage.getItem(RKEY(slug)) || "null"); } catch (e) { return null; } };
const saveProgress = (slug, p) => { try { localStorage.setItem(RKEY(slug), JSON.stringify(p)); } catch (e) {} };
const clearProgress = (slug) => { try { localStorage.removeItem(RKEY(slug)); } catch (e) {} };
export const pendingDeploy = (slug) => loadProgress(slug);

// One funding transfer covers: manifest inscription (the first write carries
// the burner's init rent), collection.json, and the deploy tx. Generous on
// purpose; the remainder sweeps back.
async function deployBudget(connection, burner, { manifestJson, collectionJson, deployFeeLamports }) {
  const accountRent = await getAccountRent(connection, burner.publicKey);
  const manifest = estimateCost(new TextEncoder().encode(manifestJson).length, { accountRent }).total;
  const coll = estimateCost(new TextEncoder().encode(collectionJson).length, { accountRent: 0 }).total;
  return manifest + coll + Number(deployFeeLamports || 0) + DEPLOY_OVERHEAD;
}

// ── deploy ──────────────────────────────────────────────────────────────────
// items: [{ index?, name, imageData, template }] where imageData is decoded
// pixels or a thunk returning them (generative sets composite one at a time so
// thousands of bitmaps never sit in memory). onStage(stage, extra): compress,
// stage, funding, manifest, logo, banner, collection, deploy, finalize, done.
export async function deploy({ connection, wallet, burner, spec, items, onStage }) {
  const who = wallet.publicKey.toBase58();
  const burnerPk = burner.publicKey.toBase58();
  const stage = (s, x) => { try { onStage && onStage(s, x); } catch (e) {} };
  const slug = spec.slug;

  let p = loadProgress(slug);
  if (p && (p.wallet !== who || p.burner !== burnerPk)) p = null;
  p = p || { wallet: who, burner: burnerPk };
  const currency = spec.currency || "SOL";
  if (p.stagingId && ((p.currency || "SOL") !== currency || p.price != null && p.price !== spec.price)) {
    throw new Error("Restore the saved currency and price to resume this deployment.");
  }

  // 1. Compress + stage in batches (begin -> batch* -> finish); the backend
  //    uploads each batch to Arweave and keeps the shuffle seed server-side.
  if (!p.stagingId) {
    const begin = await call("/creator/stage/begin", {
      slug, creator: who, name: spec.name, symbol: spec.symbol,
      description: spec.description || "", price: spec.price || 0, deposit: spec.deposit || 0,
      currency,
      royaltyBps: spec.royaltyBps || 0, sequential: !!spec.sequential,
    });
    if (begin.status === 409) throw new Error('the handle "' + slug + '" is taken; pick another');
    if (begin.status !== 200) throw new Error((begin.json && begin.json.error) || "stage failed (" + begin.status + ")");
    const stagingId = begin.json.stagingId;

    let batch = [], uploaded = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await call("/creator/stage/batch", { stagingId, items: batch });
      if (r.status !== 200) throw new Error((r.json && r.json.error) || "upload failed (" + r.status + ")");
      uploaded += batch.length;
      batch = [];
      stage("stage", { done: uploaded, total: items.length });
      await tick();
    };
    for (let i = 0; i < items.length; i++) {
      stage("compress", { done: i, total: items.length });
      const src = items[i].imageData;
      const imageData = typeof src === "function" ? await src() : src;
      const { bytes, mime } = await compressImage(imageData, spec.compress);
      batch.push({ index: items[i].index ?? i + 1, name: items[i].name, mime, imageBase64: bytesToBase64(bytes), template: items[i].template || {} });
      await tick();
      if (batch.length >= STAGE_BATCH) await flush();
    }
    await flush();

    const fin = await call("/creator/stage/finish", { stagingId });
    if (fin.status !== 200) throw new Error((fin.json && fin.json.error) || "stage finish failed (" + fin.status + ")");
    Object.assign(p, {
      stagingId, currency, price: spec.price, manifestJson: fin.json.manifestJson, collectionJson: fin.json.collectionJson,
      itemCount: fin.json.itemCount, deployFeeLamports: fin.json.deployFeeLamports,
    });
    saveProgress(slug, p);
  }

  // 2. Fund once (manifest + collection.json + deploy tx + optional logo/banner).
  if (!p.funded) {
    stage("funding");
    let budget = await deployBudget(connection, burner, p);
    const extraImgs = (spec.logo ? 1 : 0) + (spec.banner ? 1 : 0);
    if (extraImgs) budget += extraImgs * estimateCost(Math.ceil((160 * 1024 * 4) / 3) + 128, { accountRent: 0 }).total;
    await topUp(connection, wallet, burner.publicKey, budget);
    p.funded = true; saveProgress(slug, p);
  }

  // 3. Inscribe the manifest.
  if (!p.manifestSig) {
    stage("manifest");
    p.manifestSig = await writer.codeIn({ connection, signer: burner }, p.manifestJson, "manifest.json", 0, "json");
    saveProgress(slug, p);
  }

  // 3b. Optional logo/banner: compress + inscribe as feed-row images (so
  //     gateway/img/{sig} serves them), then rebuild collection.json to point
  //     at those inscriptions.
  const resolve = async (x) => (typeof x === "function" ? await x() : x);
  const inscribeImage = async (imageData, maxEdge) => {
    const { bytes, mime } = await compressImage(imageData, { maxEdge });
    const row = { kind: "image", body: "data:" + mime + ";base64," + bytesToBase64(bytes), who };
    const signature = await writeFeedRow({ connection, burner, row: JSON.stringify(row), owner: wallet.publicKey });
    void notify(signature, { ...row, __signer: burnerPk }, { signer: who });
    return signature;
  };
  if (spec.logo && !p.logoSig) { stage("logo"); p.logoSig = await inscribeImage(await resolve(spec.logo), 512); saveProgress(slug, p); }
  if (spec.banner && !p.bannerSig) { stage("banner"); p.bannerSig = await inscribeImage(await resolve(spec.banner), 1024); saveProgress(slug, p); }
  if ((spec.logo || spec.banner) && !p.collFinal) {
    const r = await call("/creator/collection-json", { stagingId: p.stagingId, logoSig: p.logoSig, bannerSig: p.bannerSig });
    if (r.status !== 200) throw new Error((r.json && r.json.error) || "collection-json failed (" + r.status + ")");
    p.collectionJson = r.json.collectionJson; p.collFinal = true; saveProgress(slug, p);
  }

  // 4. Inscribe collection.json.
  if (!p.metaSig) {
    stage("collection");
    p.metaSig = await writer.codeIn({ connection, signer: burner }, p.collectionJson, "collection.json", 0, "json");
    saveProgress(slug, p);
  }

  // 5. The collection keypair is throwaway and client-held; persist it so a
  //    resume builds against the same account the backend co-signs.
  let col;
  if (p.collectionSecret) col = Keypair.fromSecretKey(Uint8Array.from(p.collectionSecret));
  else { col = Keypair.generate(); p.collectionSecret = Array.from(col.secretKey); saveProgress(slug, p); }

  // 6. Build the deploy tx (backend), sign (burner payer + collection), land.
  stage("deploy");
  const d = await call("/creator/deploy", { stagingId: p.stagingId, creator: who, collection: col.publicKey.toBase58(), payer: burnerPk, manifestSig: p.manifestSig, metaSig: p.metaSig });
  if (d.status === 404) { clearProgress(slug); throw new Error("the staged deploy expired; run it again"); }
  if (d.status !== 200) throw new Error((d.json && d.json.error) || "deploy build failed (" + d.status + ")");
  const tx = Transaction.from(base64ToBytes(d.json.transaction));
  tx.partialSign(burner, col);
  const deploySig = await connection.sendRawTransaction(tx.serialize());
  if (!(await confirmOrCheck(connection, deploySig, tx.recentBlockhash, d.json.lastValidBlockHeight))) throw new Error("deploy tx was not confirmed");

  // 7. Finalize (DB rows once the registry is on chain), sweep, report.
  stage("finalize");
  const f = await call("/creator/finalize", { stagingId: p.stagingId });
  if (f.status !== 200) throw new Error((f.json && f.json.error) || "finalize failed (" + f.status + ")");
  await sweep(connection, burner, wallet.publicKey).catch(() => {});
  clearProgress(slug);
  const result = { slug, collection: col.publicKey.toBase58(), registry: d.json.registry, deploySig, itemCount: p.itemCount };
  stage("done", result);
  return result;
}
