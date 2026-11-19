// Collection page (design/NFT Launchpad Flow v5): header + item grid on the
// left, the mint panel on the right. Unminted items are SEALED (no art before
// mint; a sealed cell's rarity would leak the next sequential item). The mint
// runs inline in the panel: approve -> confirming (tty bar + log) -> Minted.
import { esc, fmtSol, shortAddr } from "../../ui/fmt.js";
import * as nft from "../../services/nft-backend.js";
import { imgUrl } from "../../services/gateway.js";
import { nftMarkets } from "../../services/markets.js";
import { skeleton } from "../../ui/skeleton.js";
import { paintProgress } from "../../ui/tty.js";
import { connect as rpcConnect, explorerTx } from "../../chain/rpc.js";
import { collectionCurrency, formatMintUnits, isStockCurrency, mintPaymentOptions, isLoopback } from "../../chain/nft-currency.js";
import { frame, statusOf, chainOf, coverOf, segsHtml } from "./launchpad.js";
import { session, addr, connectWallet, ensureBurner, paintWalletPill } from "./session.js";
import { mint, pendingMint } from "../../chain/nft.js";
import { mintPlatformFee, PLATFORM_FEE_BPS } from "../../chain/nft-fees.js";

const PAGE = 500;
const TIER_LABEL = { legendary: "Legendary", epic: "EPIC", rare: "RARE" };
const st = { col: null, items: [], total: 0, hasRarity: false, filter: "all", mint: "idle", pct: 0, log: [], result: null, error: null, busy: false, payWithSol: false };

export async function render(root, slug) {
  const body = frame(root, `<div class="win nf-win nf-colwin"><div class="wh"><span>Collection · ${esc(slug)}</span><a class="wh-right wh-x" href="?view=nft">← all collections</a></div><div class="nf-note">loading...</div></div>`);
  paintWalletPill(root.querySelector("#nav_wallet"), () => { paintMint(root); refreshSolAvailability(root); });
  let col;
  try { col = await nft.collection(slug); }
  catch (e) { body.querySelector(".nf-note").textContent = 'could not load "' + slug + '": ' + e.message; return; }
  if (!body.isConnected) return;
  Object.assign(st, { col, items: [], total: 0, hasRarity: false, filter: "all", mint: "idle", pct: 0, log: [], result: null, error: null, busy: false, payWithSol: false, quoteWallet: null });

  const ch = chainOf(col);
  const status = statusOf(col);
  const currency = collectionCurrency(col);
  const mintUnit = esc(currency.symbol);
  const formatMintAmount = (raw) => formatMintUnits(raw, currency.decimals);
  const mintPrice = BigInt(col.priceLamports || 0);
  const priceLabel = mintPrice ? formatMintAmount(mintPrice) : "FREE";
  const platformFee = mintPlatformFee(mintPrice);
  const logo = col.logo || (col.coverSig ? imgUrl(col.coverSig) : "");
  body.innerHTML = `
<div class="win nf-win nf-colwin">
  <div class="wh"><span>Collection · ${esc(col.slug)}</span><a class="wh-right wh-x" href="?view=nft">← all collections</a></div>
  ${col.banner ? `<img class="nf-colbanner" src="${esc(col.banner)}" alt="">` : ""}
  <div class="nf-colpage">
    <div class="nf-colleft">
      <div class="nf-colhead">
        ${logo ? `<div class="nf-collogo"><img src="${esc(logo)}" alt=""></div>` : ""}
        <div class="nf-colinfo">
          <div class="nf-coltitle"><div class="nf-colname">${esc(col.name)}</div><span class="chip ${status === "LIVE" ? "live" : status === "Upcoming" ? "soon" : "out"}">${status}</span><span class="chip">${ch.icon} ${esc(ch.name)}</span></div>
          <div class="cm" style="margin-top:6px">by ${esc(shortAddr(col.creator))} · ${col.maxSupply.toLocaleString("en-US")} items${col.symbol ? " · $" + esc(col.symbol) : ""}</div>
          <p class="nf-coldesc clamp" id="nc_desc">${esc(col.description || "")}</p>
          <button type="button" class="nf-descmore" id="nc_descmore" aria-controls="nc_desc" aria-expanded="false" hidden>see more</button>
          <div class="nf-collinks lab">
            <a class="btn2" href="https://solscan.io/account/${esc(col.collection)}" target="_blank" rel="noopener">Collection on chain</a>
            <a class="btn2" href="https://magiceden.io/marketplace/${esc(col.collection)}" target="_blank" rel="noopener">Magic eden</a>
          </div>
        </div>
      </div>
      <div class="nf-itemsbar">
        <div class="lab" style="opacity:.7">// ITEMS · ${col.sequential ? "sequential" : "random, committed shuffle"}</div>
        <div class="nf-tabs lab"><div class="tab on" data-f="all">All</div><div class="tab" data-f="avail">Available</div><div class="tab" data-f="minted">Minted</div></div>
      </div>
      <div class="nf-legend" id="nc_legend"><span style="opacity:.4;margin-left:auto">? = not minted yet</span></div>
      <div class="nf-itemscroll"><div class="nf-itemgrid" id="nc_grid">${skeleton(18, "cell")}</div><div class="nf-note" id="nc_gridnote"></div></div>
      <p class="cm" style="margin:14px 0 0">Bright = minted, with its owner. ? = still available.</p>
    </div>
    <div class="nf-colright">
      <div class="lab" style="letter-spacing:.2em;opacity:.7">Mint</div>
      <div class="nf-pricebox">
        <div class="nf-price"><span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
          <span class="nf-pricenum${priceLabel.length > 6 ? " nf-pricenum-long" : ""}">${priceLabel}</span>${mintPrice ? `<span class="nf-priceunit">${mintUnit}</span>` : ""}</div>
        ${ch.unit === "SOL" && mintPrice ? `
          <dl class="nf-mint-costs">
            <div class="kv"><dt>Platform fee (${PLATFORM_FEE_BPS / 100}%)</dt><dd>${formatMintAmount(platformFee)} ${mintUnit}</dd></div>
            <div class="kv"><dt>Subtotal</dt><dd>${formatMintAmount(mintPrice + platformFee)} ${mintUnit}</dd></div>
          </dl>` : ""}
        <div class="cm" style="margin-top:10px">${ch.unit !== "SOL" ? "Network costs are additional." : isStockCurrency(col.currency) ? "Inscription, account rent, and network costs are paid in SOL." : "One approval funds your burner wallet for the mint, including a buffer for inscription, account rent and network fees. Unused SOL is sent back after minting."}</div>
        ${isStockCurrency(col.currency) ? '<div class="cm">Your wallet may apply the issuer’s display adjustment to the token amount.</div>' : ""}
      </div>
      <div>
        <div class="cc-segs" style="height:14px;margin:0" id="nc_segs">${segsHtml(col.minted, col.maxSupply)}</div>
        <div class="nf-mintedline"><span style="color:var(--acc)" id="nc_mintedlabel">${col.minted.toLocaleString("en-US")} / ${col.maxSupply.toLocaleString("en-US")}</span><span>Minted</span></div>
      </div>
      <details class="nf-details"><summary>details ▸</summary><div>
        <div class="kv"><span>phase</span><span class="${status === "LIVE" ? "mint" : status === "Upcoming" ? "amber" : ""}">${col.allowlistOnly ? "ALLOWLIST" : "PUBLIC"} · ${status}</span></div>
        <div class="kv"><span>per wallet</span><span>${col.maxPerWallet ? col.maxPerWallet + " per wallet" : "no limit"}</span></div>
        <div class="kv"><span>starts / ends</span><span>${when(col.startAt) || "open"} → ${when(col.endAt) || "open"}</span></div>
        <div class="kv"><span>order</span><span>${col.sequential ? "sequential" : "random"}</span></div>
        ${col.depositLamports ? `<div class="kv"><span>deposit</span><span>${fmtSol(col.depositLamports)} at reservation, counts toward the price</span></div>` : ""}
        <div class="kv"><span>you</span><span id="nc_you">${addr() ? "connected" : "not connected"}</span></div>
      </div></details>
      <div id="nc_mint"></div>
    </div>
  </div>
</div>`;

  const banner = body.querySelector(".nf-colbanner");
  if (banner) {
    const fitBanner = () => {
      if (banner.naturalWidth && banner.naturalWidth === banner.naturalHeight) banner.classList.add("square");
    };
    if (banner.complete) fitBanner();
    else banner.addEventListener("load", fitBanner, { once: true });
  }

  const desc = body.querySelector("#nc_desc"), dmore = body.querySelector("#nc_descmore");
  function expandDescription(expanded) {
    desc.classList.toggle("clamp", !expanded);
    dmore.textContent = expanded ? "see less" : "see more";
    dmore.setAttribute("aria-expanded", String(expanded));
  }
  function syncDescription() {
    if (!desc.isConnected) { descriptionObserver.disconnect(); return; }
    const style = getComputedStyle(desc);
    const collapsedHeight = parseFloat(style.lineHeight) * Number(style.getPropertyValue("--desc-lines"));
    dmore.hidden = desc.scrollHeight <= Math.ceil(collapsedHeight);
    if (dmore.hidden) expandDescription(false);
  }
  const descriptionObserver = new ResizeObserver(syncDescription);
  descriptionObserver.observe(desc);
  document.fonts.ready.then(syncDescription);
  dmore.onclick = () => expandDescription(desc.classList.contains("clamp"));

  for (const t of body.querySelectorAll(".nf-tabs .tab")) t.onclick = () => {
    st.filter = t.dataset.f;
    for (const x of body.querySelectorAll(".nf-tabs .tab")) x.classList.toggle("on", x === t);
    paintGrid(root);
  };
  paintMint(root);
  refreshSolAvailability(root);
  loadItems(root);
}

const when = (unix) => (unix ? new Date(unix * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

// Items arrive 500 at a time and are drawn as they land; minted indexes are
// scattered (random assignment), so the Minted filter needs the whole set.
async function loadItems(root) {
  const note = root.querySelector("#nc_gridnote");
  let offset = 0;
  do {
    let res;
    try { res = await nft.items(st.col.slug, offset, PAGE); }
    catch (e) { if (note) note.textContent = e.message; return; }
    if (!root.isConnected) return;
    st.hasRarity = !!res.hasRarity;
    st.total = res.total || st.col.maxSupply;
    st.items.push(...res.items);
    offset += res.items.length;
    paintGrid(root);
    if (note) note.textContent = offset < st.total ? "loading " + offset + " / " + st.total + "..." : "";
    if (!res.items.length) break;
  } while (offset < st.total);
  if (st.hasRarity) {
    const l = root.querySelector("#nc_legend");
    if (l) l.innerHTML = '<span style="color:#b07a1a">■ Legendary 2%</span><span style="color:#6a3fb5">■ EPIC 8%</span><span style="color:#1f5fbf">■ RARE 20%</span><span>■ Common</span><span style="opacity:.4;margin-left:auto">? = not minted yet</span>';
  }
}

function paintGrid(root) {
  const grid = root.querySelector("#nc_grid");
  if (!grid) return;
  const items = st.items.filter((it) => st.filter === "all" || (st.filter === "avail" ? !it.minted : it.minted));
  grid.innerHTML = items.map(cellHtml).join("");
}

function cellHtml(it) {
  if (!it.minted) {
    const cover = coverOf(st.col);
    return `<div class="icell locked"><div class="icell-img">${cover ? `<img class="icell-lock" src="${esc(cover)}" alt="" loading="lazy">` : ""}<span class="icell-q">?</span><span class="icell-th">#${it.index}</span></div>
      <div class="icell-foot"><span>#${it.index}</span><span class="icell-st">available</span></div></div>`;
  }
  const tier = (it.rarity && it.rarity.tier) || "";
  return `<a class="icell minted ${tier}" href="?view=nft&asset=${esc(it.asset)}">
    <div class="icell-img"><img src="${esc(imgUrl(it.inscriptionSig))}" alt="" loading="lazy">${tier ? `<span class="icell-tag">${TIER_LABEL[tier] || tier}</span>` : ""}<span class="icell-th">#${it.index}</span></div>
    <div class="icell-foot"><span>${esc(shortAddr(it.owner))}</span><span class="icell-st">${tier ? TIER_LABEL[tier] : "minted"}</span></div></a>`;
}

// ── mint panel ──────────────────────────────────────────────────────────────

async function requestSolQuote(collection, wallet) {
  const query = new URLSearchParams({ wallet });
  const { status, json } = await nft.call("/c/" + encodeURIComponent(collection.slug) + "/pay-with-sol/quote?" + query);
  if (status !== 200 || !Object.hasOwn(json ?? {}, "payWithSol")) {
    throw new Error(json?.error || "Could not get an exact stock swap quote. Try again.");
  }
  if (json.payWithSol !== null) {
    const { verifySolQuote } = await import("../../chain/nft-sol-payment.js");
    verifySolQuote(json.payWithSol, collection);
  }
  return json.payWithSol;
}

async function refreshSolAvailability(root) {
  const collection = st.col, wallet = addr(), panel = root.querySelector("#nc_mint");
  if (!panel?.isConnected || !collection || st.mint !== "idle") return;
  if (st.quoteWallet === wallet) return;
  st.quoteWallet = wallet;
  st.payWithSol = false;
  if (!wallet || !isStockCurrency(collection.currency) || !isLoopback(location.hostname) ||
      statusOf(collection) !== "LIVE") return;
  try {
    const options = await mintPaymentOptions();
    if (!options.payWithSolMints.includes(collection.currency.mint)) return;
    const quote = await requestSolQuote(collection, wallet);
    if (panel.isConnected && st.col === collection && addr() === wallet && st.mint === "idle") {
      st.payWithSol = quote !== null;
      paintMint(root);
    }
  } catch {
    // Keep direct stock payment available if this wallet cannot get a route.
  }
}

function paintMint(root) {
  const el = root.querySelector("#nc_mint");
  if (!el || !st.col) return;
  const col = st.col;
  const stock = isStockCurrency(col.currency);
  const you = root.querySelector("#nc_you");
  if (you) you.textContent = addr() ? "connected · " + shortAddr(addr()) : "not connected";
  if (st.mint === "quote") {
    el.innerHTML = '<div class="ttyspin nf-approve" role="status">Checking the exact stock shortfall…</div>';
    return;
  }
  if (st.mint === "prepare") {
    el.innerHTML = '<div class="ttyspin nf-approve">Preparing mint…</div>';
    return;
  }
  if (st.mint === "approve") {
    if (st.stockApproval) {
      const detail = st.swapApproval ? "Approve the reviewed swap and mint together in your wallet." : "Review the stock-token payment that completes the mint.";
      el.innerHTML = `<div class="ttyspin nf-approve">Approve in your wallet…</div><div class="cm">${detail}</div>`;
    } else {
      const purpose = stock ? "cover inscription costs" : "cover the mint";
      el.innerHTML = `<div class="ttyspin nf-approve">Approve ${formatMintUnits(st.fundingLamports, 9)} SOL in your wallet</div>
        <div class="cm">This amount goes to your burner wallet to ${purpose}. Any unused SOL comes back after minting. Your wallet may show a separate network fee for this transfer.</div>`;
    }
    return;
  }
  if (st.mint === "confirm") {
    el.innerHTML = `<div class="ttybar" id="nc_bar"><progress max="100" aria-label="Mint progress"></progress><span aria-hidden="true"></span></div><div class="ttyspin cm" style="margin-top:6px" id="nc_phase">${esc(st.log[st.log.length - 1] || "working…")}</div>
      <div class="nf-log" id="nc_log">${st.log.map((l) => "<div>&gt; " + esc(l) + "</div>").join("")}</div>
      <div class="cm">Keep this tab open. If it stops, come back and press Resume: every step is checkpointed, nothing is paid twice.</div>`;
    paintProgress(el.querySelector("#nc_bar"), st.pct);
    return;
  }
  if (st.mint === "done") {
    const r = st.result;
    el.innerHTML = `
      <div style="text-align:center;padding:6px 0 2px"><div data-tty class="nf-minted">Minted.</div><div class="cm" style="margin-top:10px">${esc(r.name || col.name + " #" + r.index)} · owner ${esc(shortAddr(addr()))}</div></div>
      <div>
        ${r.refundLamports > 0 ? `<div class="kv"><span>unused SOL returned</span><span>${formatMintUnits(r.refundLamports, 9)} SOL</span></div>`
          : r.refundLamports === null ? '<div class="cm">Refund could not be confirmed. Any remaining SOL can be reused for your next mint.</div>' : ""}
        <div class="kv"><span>image on chain</span><span class="mint">${esc(shortAddr(r.C))}</span></div>
        <div class="kv"><span>details on chain</span><span class="mint">${esc(shortAddr(r.M))}</span></div>
        <div class="kv"><span>link</span><span>gateway.iqlabs.dev/token-meta/${esc(shortAddr(r.M))}</span></div>
      </div>
      <div class="nf-btnrow lab">
        <a class="btng" href="?view=nft&asset=${esc(r.asset)}">View NFT →</a>
        ${nftMarkets.map((m) => `<a class="btn2" href="${esc(m.item(r.asset))}" target="_blank" rel="noopener">${esc(m.label)}</a>`).join("")}
        <a class="btn2" href="${esc(explorerTx(r.C))}" target="_blank" rel="noopener">Solscan</a>
        <button class="btn2" id="nc_again">Mint another</button>
      </div>`;
    el.querySelector("#nc_again").onclick = () => {
      st.mint = "idle"; st.result = null; st.payWithSol = false; st.quoteWallet = null;
      paintMint(root);
      refreshSolAvailability(root);
    };
    return;
  }
  // idle (or paused with an error)
  const status = statusOf(col);
  const resume = pendingMint(col.slug);
  const cannot = status === "Upcoming" ? "Not started yet" : status === "Sold out" ? "Sold out · see magic eden" : status === "Ended" ? "Mint ended" : null;
  el.innerHTML = `
    ${st.error ? `<div class="cm" style="color:var(--bad)">${esc(st.error)}</div>` : ""}
    ${!addr() ? '<div class="nf-connectmint" id="nc_connect">Connect wallet to mint</div>'
      : cannot ? `<div class="btn2 nf-cannot">${cannot}</div>`
      : `<div class="nf-mint-actions">
        <button class="btn nf-mintbtn" id="nc_mintbtn">${resume ? "Resume mint" : "Mint one"}</button>
        ${st.payWithSol && !resume?.reservationId ? '<button class="btn2" id="nc_solmint">Pay with SOL</button>' : ""}
      </div>`}
    ${resume && !st.error ? '<div class="cm" style="color:#8dffa0">An unfinished mint was found; only the missing steps are redone.</div>' : ""}
    <div class="cm"><div>${stock ? (st.payWithSol
      ? `Use your ${esc(col.currency.symbol)} balance first. Pay with SOL buys any shortfall at checkout.`
      : `Have ${esc(col.currency.symbol)} in your wallet before minting. Approve SOL for on-chain costs first, then the stock payment.`) : "One signature. You pay, you own it."}</div><div>The NFT points at its image and details stored on chain.</div></div>`;
  const c = el.querySelector("#nc_connect");
  if (c) c.onclick = () => connectWallet().then(() => { paintWalletPill(root.querySelector("#nav_wallet"), () => { paintMint(root); refreshSolAvailability(root); }); paintMint(root); refreshSolAvailability(root); }).catch((e) => alert(e.message));
  const b = el.querySelector("#nc_mintbtn");
  if (b) b.onclick = () => runMint(root, Boolean(resume?.payWithSol));
  const sol = el.querySelector("#nc_solmint");
  if (sol) sol.onclick = () => runMint(root, true);
}

async function reviewSolQuote(host, quote, currency) {
  if (!host?.isConnected) return Promise.resolve(false);
  const { swapVenue } = await import("../../chain/nft-sol-payment.js");
  const venue = swapVenue(quote.routerProgram);
  const preliminary = quote.feeLamports == null;
  const dialog = document.createElement("dialog");
  dialog.className = "nf-sol-review win";
  dialog.setAttribute("aria-labelledby", "nf_sol_review_title");
  const stock = units => formatMintUnits(units, currency.decimals) + " " + esc(currency.symbol);
  const sol = units => formatMintUnits(units, 9) + " SOL";
  dialog.innerHTML = `
    <div class="wh" id="nf_sol_review_title"><span>${preliminary ? "Review " + (venue ? venue + " " : "") + "quote" : "Review SOL payment"}</span></div>
    <form method="dialog" class="nf-sol-review-body">
      <div class="kv"><span>Stock due, including platform fee</span><b>${stock(quote.stockDueUnits)}</b></div>
      <div class="kv"><span>Stock to buy</span><b>${stock(quote.shortfallUnits)}</b></div>
      <div class="kv"><span>Max SOL for swap</span><b>${sol(quote.inputLimitLamports)}</b></div>
      ${preliminary ? "" : `<div class="kv"><span>Network fee</span><b>${sol(quote.feeLamports)}</b></div>`}
      ${quote.estimatedTotalLamports == null ? "" : `<div class="kv"><span>Estimated SOL for swap + mint</span><b>${sol(quote.estimatedTotalLamports)}</b></div>`}
      <p class="cm">${preliminary ? "You’ll approve inscription funding separately and see a fresh swap quote before minting." : "The swap and mint settle together through " + (venue || "the quoted venue") + ". The estimate includes network fees and account rent. Inscription funding is separate."}</p>
      ${quote.intermediateUnits ? '<p class="cm">Unused USDC from the route stays in your wallet.</p>' : ""}
      <div class="nf-mint-actions">
        <button class="btn2" value="cancel" autofocus>Cancel</button>
        <button class="btn" value="approve">${preliminary ? "Continue to mint" : "Continue to wallet"}</button>
      </div>
    </form>`;
  host.append(dialog);
  return new Promise(resolve => {
    const observer = new MutationObserver(() => { if (!dialog.isConnected) finish(false); });
    const finish = approved => {
      observer.disconnect();
      dialog.remove();
      resolve(approved);
    };
    dialog.addEventListener("close", () => finish(dialog.returnValue === "approve"), { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
    dialog.showModal();
  });
}

const STAGE_PCT = { funding: 5, deposit: 15, reserve: 20, image: 25, metadata: 80, register: 90, confirming: 95 };
const STAGE_LINE = {
  deposit: () => "deposit paid",
  reserve: () => "reserving your item",
  image: (x) => "item " + (x && x.index != null ? "#" + x.index : "") + ": inscribing the image",
  metadata: () => "inscribing the details",
  register: () => "registering the NFT (co-sign)",
  confirming: () => "waiting for confirmation",
};

async function runMint(root, payWithSol = false) {
  if (st.busy) return;
  const collection = st.col, wallet = session.wallet, modalHost = root.querySelector("#nf_modal");
  st.busy = true; st.error = null; st.log = []; st.pct = 0; st.stockApproval = false; st.swapApproval = false;
  st.mint = payWithSol ? "quote" : "prepare"; paintMint(root);
  const live = () => {
    const b = root.querySelector("#nc_bar"), ph = root.querySelector("#nc_phase"), lg = root.querySelector("#nc_log");
    if (b) paintProgress(b, st.pct);
    if (ph) ph.textContent = st.log[st.log.length - 1] || "";
    if (lg) lg.innerHTML = st.log.map((l) => "<div>&gt; " + esc(l) + "</div>").join("");
  };
  try {
    const connection = rpcConnect();
    if (payWithSol) {
      const { assertLocalSolPayment } = await import("../../chain/nft-sol-payment.js");
      assertLocalSolPayment(connection);
      const buyer = wallet.publicKey;
      const pending = pendingMint(collection.slug);
      if (pending?.wallet !== buyer.toBase58() || !pending.reservationId) {
        const quote = await requestSolQuote(collection, buyer.toBase58());
        if (quote !== null) {
          if (!await reviewSolQuote(modalHost, quote, collection.currency)) {
            if (modalHost.isConnected) {
              st.mint = "idle";
              paintMint(root);
            }
            return;
          }
        }
      }
      if (!modalHost.isConnected || session.wallet !== wallet || !wallet.publicKey.equals(buyer)) {
        throw new Error("The wallet or collection changed. Reopen checkout.");
      }
      st.mint = "prepare";
      paintMint(root);
    }
    const burner = await ensureBurner();
    const result = await mint({
      connection, wallet, burner, slug: collection.slug, collection, payWithSol,
      reviewSolPayment: quote => reviewSolQuote(modalHost, quote, collection.currency),
      onStage: (s, x) => {
        if (!modalHost.isConnected) return;
        if (s === "funding" || s === "stock-payment") { st.stockApproval = s === "stock-payment"; st.swapApproval = Boolean(x?.swap); st.fundingLamports = x?.lamports; st.mint = "approve"; paintMint(root); return; }
        if (st.mint !== "confirm") { st.mint = "confirm"; paintMint(root); }
        if (STAGE_PCT[s]) st.pct = Math.max(st.pct, STAGE_PCT[s]);
        if (STAGE_LINE[s]) { st.log.push(STAGE_LINE[s](x)); live(); }
      },
      onProgress: (p) => { st.pct = Math.max(st.pct, 25 + Math.round(p * 0.55)); live(); },
    });
    if (!modalHost.isConnected) return;
    st.result = result;
    st.mint = "done";
    paintMint(root);
    // the grid cell lights up and the counts move
    nft.collection(st.col.slug).then((c) => {
      st.col = c;
      const s = root.querySelector("#nc_segs"), m = root.querySelector("#nc_mintedlabel");
      if (s) s.innerHTML = segsHtml(c.minted, c.maxSupply);
      if (m) m.textContent = c.minted.toLocaleString("en-US") + " / " + c.maxSupply.toLocaleString("en-US");
      st.items = []; loadItems(root);
    }).catch(() => {});
  } catch (e) {
    if (!modalHost.isConnected) return;
    st.error = String((e && e.message) || e);
    if (payWithSol) st.payWithSol = false;
    st.mint = "idle";
    paintMint(root);
  } finally {
    if (modalHost.isConnected) st.busy = false;
  }
}
