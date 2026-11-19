// NFT side (design/NFT Launchpad Flow v5). This module is the sub-router and
// the launchpad desk (COLLECTIONS / MARKET / MY NFTS + the activity column);
// the collection page, the asset viewer, the single mint and the launch wizard
// are their own modules, dispatched on the query params:
//   ?view=nft            -> this desk
//   ?view=nft&c=<slug>   -> collection page
//   ?view=nft&asset=<a>  -> asset viewer
//   ?view=nft&single=<C> -> single 1/1 mint
import { nav } from "../../ui/nav.js";
import { skeleton } from "../../ui/skeleton.js";
import { typeLabels } from "../../ui/tty.js";
import { esc, fmtSol, fmtWhen, shortAddr } from "../../ui/fmt.js";
import * as nft from "../../services/nft-backend.js";
import { imgUrl } from "../../services/gateway.js";
import { nftMarketOf } from "../../services/markets.js";
import { addr, paintWalletPill } from "./session.js";
import { collectionCurrency, formatMintUnits, isStockCurrency } from "../../chain/nft-currency.js";

export async function mount(root) {
  const q = new URLSearchParams(location.search);
  if (q.get("c")) return (await import("./collection.js")).render(root, q.get("c"));
  if (q.get("asset")) return (await import("./viewer.js")).render(root, q.get("asset"));
  if (q.get("single")) return (await import("./single.js")).render(root, q.get("single"));
  return desk(root);
}

// Shared page frame: nav + the viewport-high page column every NFT screen
// sits in. Returns the body element.
export function frame(root, bodyHtml) {
  root.innerHTML = `<div class="nf-page">${nav("nft")}<div id="nf_body" class="nf-desk">${bodyHtml}</div></div><div id="nf_modal"></div>`;
  // Item links open the asset in a popup over the current screen instead of
  // routing away. Stop here (below document) so the global ?view= router does
  // not navigate; a direct ?asset= URL still renders the full page.
  root.querySelector(".nf-page").addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="?view=nft&asset="]');
    if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const asset = new URLSearchParams(a.getAttribute("href").slice(1)).get("asset");
    if (asset) import("./viewer.js").then((m) => m.openModal(asset));
  });
  typeLabels(root);
  return root.querySelector("#nf_body");
}

// ── collection facts shared by the desk cards and the collection page ──────
const SEGS = 40;
export const COLLECTION_CHAIN = { solana: { icon: "◎", name: "SOLANA", std: "MPL CORE", unit: "SOL" }, robinhood: { icon: "▲", name: "ROBINHOOD", std: "ERC721", unit: "ETH" } };
export const chainOf = (c) => COLLECTION_CHAIN[c.chain] || COLLECTION_CHAIN.solana;

export function statusOf(c) {
  const now = Date.now() / 1000;
  if (c.maxSupply && c.minted >= c.maxSupply) return "Sold out";
  if (c.endAt && c.endAt < now) return "Ended";
  if (c.startAt && c.startAt > now) return "Upcoming";
  return "LIVE";
}
export const priceOf = (c) => {
  const currency = collectionCurrency(c);
  return c.priceLamports ? `${formatMintUnits(c.priceLamports, currency.decimals)} ${esc(currency.symbol)}` : "FREE";
};
export const coverOf = (c) => c.banner || c.logo || (c.coverSig ? imgUrl(c.coverSig) : "");
export const segsHtml = (minted, supply) => {
  const on = supply ? Math.round((SEGS * minted) / supply) : 0;
  let s = "";
  for (let k = 0; k < SEGS; k++) s += k < on ? '<i class="on"></i>' : "<i></i>";
  return s;
};

// ── desk ───────────────────────────────────────────────────────────────────
const PER = 6;
const st = { tab: "cols", chain: "all", page: 1, cols: null, listings: null };

async function desk(root) {
  frame(root, `
<div class="win nf-win nf-lp">
  <div class="wh">
    <span data-tty>Collections</span>
    <span class="wh-right wh-plain"><select id="nf_chain" class="nf-select">
      <option value="all">All chains</option><option value="solana">◎ Solana</option><option value="robinhood">▲ Robinhood</option>
    </select></span>
  </div>
  <div class="nf-lpbody">
    <div class="nf-tabrow">
      <div class="nf-tabs lab">
        <div class="tab" data-tab="cols">Collections</div>
        <div class="tab" data-tab="market">Market</div>
        <div class="tab" data-tab="mine">My nfts</div>
      </div>
      <button class="btn" id="nf_launch">+ Launch a collection</button>
    </div>
    <div id="nf_tabbody" class="nf-tabbody"></div>
  </div>
</div>
<div class="win nf-win nf-act">
  <div class="wh"><span data-tty>Activity</span></div>
  <div class="nf-actbody ttyrows" id="nf_activity"><div class="nf-acthead"><span>Recent activity</span></div></div>
</div>`);

  paintWalletPill(root.querySelector("#nav_wallet"), () => { if (st.tab === "mine") paintTab(root); });
  const chain = root.querySelector("#nf_chain");
  chain.value = st.chain;
  chain.onchange = () => { st.chain = chain.value; st.page = 1; paintTab(root); };
  for (const t of root.querySelectorAll(".tab")) t.onclick = () => { st.tab = t.dataset.tab; st.page = 1; paintTab(root); };
  root.querySelector("#nf_launch").onclick = async () => (await import("./studio.js")).open(root);

  paintTab(root);
  loadActivity(root).catch(() => {
    const el = root.querySelector("#nf_activity");
    if (el) el.insertAdjacentHTML("beforeend", '<div class="nf-note">activity unavailable right now</div>');
  });
}

async function paintTab(root) {
  for (const t of root.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.tab === st.tab);
  const el = root.querySelector("#nf_tabbody");
  if (!el) return;
  try {
    if (st.tab === "cols") await paintCollections(el);
    else if (st.tab === "market") paintMarket(el);
    else await paintMine(el);
  } catch (e) { el.innerHTML = '<div class="nf-note">could not load: ' + esc(e.message) + "</div>"; }
}

async function paintCollections(el) {
  if (!st.cols) {
    el.innerHTML = `<div class="nf-scroll"><div class="nf-colgrid">${skeleton(6, "col")}</div></div>`;
    st.cols = await nft.collections();
    if (!el.isConnected || st.tab !== "cols") return;
  }
  const all = st.chain === "all" ? st.cols : st.cols.filter((c) => (c.chain || "solana") === st.chain);
  const shown = Math.min(st.page * PER, all.length);
  const pages = Math.max(1, Math.ceil(all.length / PER));
  const where = st.chain === "all" ? "all chains" : st.chain === "solana" ? "on solana" : "on robinhood chain";
  el.innerHTML = `<div class="nf-scroll" id="nf_colscroll">
    <div class="nf-colgrid ttyrows">${all.length ? all.slice(0, shown).map(cardHtml).join("") : ""}</div>
    ${all.length ? "" : `<div class="nf-empty"><div class="t">Nothing ${esc(where)} yet.</div><div class="cm">The first collection here will be the first fully onchain one on this chain.</div></div>`}
    <div class="nf-pager">
      <span>// page ${st.page} / ${pages} · showing ${shown} of ${all.length}</span>
      ${shown < all.length ? `<span class="nf-more" id="nf_more">Load more ↓</span>` : `<span class="nf-eof">EOF · ${all.length} collection${all.length === 1 ? "" : "s"}, ${esc(where)}</span>`}
    </div>
  </div>`;
  const more = el.querySelector("#nf_more");
  if (more) more.onclick = () => { st.page++; paintCollections(el); };
}

function cardHtml(c) {
  const status = statusOf(c);
  const live = status === "LIVE";
  const ch = chainOf(c);
  const hot = live && c.lastMintAt && Date.now() / 1000 - c.lastMintAt < 86400;
  const currency = collectionCurrency(c);
  const vol = c.minted && c.priceLamports ? isStockCurrency(c.currency)
    ? `${formatMintUnits(BigInt(c.minted) * BigInt(c.priceLamports), currency.decimals)} ${esc(currency.symbol)}`
    : ((c.minted * c.priceLamports) / 1e9).toFixed(2) + " " + ch.unit
    : "-";
  const cls = status === "Sold out" || status === "Ended" ? "colcard soldout dim" : live ? "colcard flick" : "colcard dim";
  const cover = coverOf(c);
  return `<a class="${cls}" href="?view=nft&c=${esc(c.slug)}">
  <div class="cc-cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ""}</div>
  <div class="cc-name">${esc(c.name)}</div>
  <div class="cc-segs">${segsHtml(c.minted, c.maxSupply)}</div>
  <div class="cc-mintrow"><span class="${live ? "amber" : ""}">${c.minted.toLocaleString("en-US")} / ${c.maxSupply.toLocaleString("en-US")}</span></div>
  <p class="cc-desc">${esc(c.description || "")}</p>
  <div class="cc-stats">
    <div class="cc-stat"><div class="cc-k">OWNERS</div><div class="cc-v"><span>${c.owners ?? "-"}</span></div></div>
    <div class="cc-stat"><div class="cc-k">VOLUME</div><div class="cc-v"><span>${vol}</span></div></div>
  </div>
  <div class="cc-meta"><span>${ch.icon} ${ch.name} · ${ch.std} · ${esc(shortAddr(c.collection))}</span>${hot ? '<span class="cc-hot">▲ HOT</span>' : ""}</div>
  <div class="band">
    <div class="bandfill ${live ? "live" : ""}" ${status === "Sold out" ? "hidden" : ""}></div>
    <div class="bandtext">
      <span class="band-price">${status === "Sold out" ? "minted out" : status === "Ended" ? "ended" : priceOf(c)}</span>
      <span class="band-cta">${live ? "Mint" : "View"} <span class="bandarrow">→</span></span>
    </div>
  </div>
</a>`;
}

// Listings are read-only here: we aggregate what sellers posted on Tensor and
// Magic Eden, and Buy deep-links to the marketplace that holds the ask.
// Active listings across every Solana collection, cheapest first, cached per
// desk mount. Robinhood has no Tensor feed, so it is skipped.
async function allListings() {
  if (st.listings) return st.listings;
  if (!st.cols) st.cols = await nft.collections();
  const sol = st.cols.filter((c) => (c.chain || "solana") === "solana" && c.maxSupply > 0);
  const packs = await Promise.all(sol.map(async (c) => {
    try { return ((await nft.listings(c.slug)).listings || []).map((l) => ({ ...l, col: c })); } catch (e) { return []; }
  }));
  st.listings = packs.flat().sort((a, b) => a.price - b.price);
  return st.listings;
}

function listCardHtml(l) {
  const src = nftMarketOf(l.source);
  const mine = addr() && l.seller === addr();
  return `<div class="rc listed">
    <a class="rc-img" href="?view=nft&asset=${esc(l.asset)}">${l.inscriptionSig ? `<img src="${esc(imgUrl(l.inscriptionSig))}" alt="" loading="lazy">` : ""}<span class="rc-tag">${esc(src.label)}</span></a>
    <div class="rc-name">${esc(l.col.name)} #${l.index ?? "?"}</div>
    <div class="rc-sub">${fmtSol(l.price)}</div>
    <a class="rc-foot amber" href="${esc(src.item(l.asset))}" target="_blank" rel="noopener"><span>${mine ? "Manage on" : "Buy on"} ${esc(src.label)}</span><span style="margin-left:auto">↗</span></a>
  </div>`;
}

async function paintMarket(el) {
  el.innerHTML = `<div class="nf-scroll"><div class="nf-minegrid">${skeleton(6, "nftitem")}</div></div>`;
  const all = await allListings();
  if (!el.isConnected || st.tab !== "market") return;
  el.innerHTML = `
  <div class="nf-stats">
    <div><div class="k">Listed</div><div class="v">${all.length || "-"}</div></div>
    <div><div class="k">Collections</div><div class="v">${new Set(all.map((l) => l.col.slug)).size || "-"}</div></div>
  </div>
  ${all.length
    ? `<div class="nf-scroll"><div class="nf-minegrid ttyrows">${all.map(listCardHtml).join("")}</div></div>`
    : `<div class="nf-empty"><div class="t">No active listings right now.</div><div class="cm">Minted items trade on Magic Eden and Tensor. Anything listed there shows up here within a couple of minutes, from any marketplace.</div></div>`}`;
}

const TIER = { legendary: "Legendary", epic: "EPIC", rare: "RARE" };

async function paintMine(el) {
  if (!addr()) {
    el.innerHTML = `<div class="nf-empty">
      <div class="t">Connect to see yours.</div>
      <div class="cm">Your NFTs appear here once your wallet is connected. Minted or bought here, they all show up.</div>
      <button class="btn" id="nf_mineconn">Connect wallet</button>
    </div>`;
    el.querySelector("#nf_mineconn").onclick = () => document.querySelector("#nav_wallet .navconnect")?.click();
    return;
  }
  el.innerHTML = `<div class="nf-scroll"><div class="nf-minegrid">${skeleton(6, "nftitem")}</div></div>`;
  const [items, all] = await Promise.all([nft.held(addr()), allListings()]);
  if (!el.isConnected || st.tab !== "mine") return;
  const listed = all.filter((l) => l.seller === addr());
  const strong = items.filter((it) => it.rarity && it.rarity.tier).length;
  const sub = (t) => `<div class="sm" style="padding:12px 2px 4px;letter-spacing:.1em">${t}</div>`;
  el.innerHTML = `
  <div class="nf-minehead"><span><b>${items.length}</b>held by ${esc(shortAddr(addr()))}</span><span>${strong ? strong + " rare or better" : ""}</span></div>
  ${listed.length ? sub("Listed by you · " + listed.length) + `<div class="nf-scroll"><div class="nf-minegrid ttyrows">${listed.map(listCardHtml).join("")}</div></div>` + sub("Held · " + items.length) : ""}
  <div class="nf-scroll"><div class="nf-minegrid ttyrows">${items.length ? items.map(mineCardHtml).join("") : ""}</div>
  ${items.length || listed.length ? "" : '<div class="nf-empty"><div class="t">Nothing here yet.</div><div class="cm">Mint from a collection and it lands here.</div></div>'}</div>`;
}

export function mineCardHtml(it) {
  const tier = it.rarity && it.rarity.tier;
  const label = TIER[tier] || "Common";
  return `<a class="rc ${tier || "common"} ${tier ? "strong" : ""}" href="?view=nft&asset=${esc(it.asset)}">
    <div class="rc-img">${it.inscriptionSig ? `<img src="${esc(imgUrl(it.inscriptionSig))}" alt="" loading="lazy">` : ""}<span class="rc-tag">${label}</span></div>
    <div class="rc-name">${esc(it.name || it.collectionName + " #" + it.index)}</div>
    <div class="rc-sub">${esc(it.collectionName || it.slug || "")} · ${fmtWhen(it.registeredAt) || "#" + it.index}</div>
    <div class="rc-foot"><span>View</span><span style="margin-left:auto">#${it.index}</span></div>
  </a>`;
}

// Activity column: the latest mints across the newest collections.
async function loadActivity(root) {
  const el = root.querySelector("#nf_activity");
  const cols = st.cols || (st.cols = await nft.collections());
  const recents = (await Promise.all(cols.slice(0, 6).map(async (c) => {
    try { return (await nft.recent(c.slug, 6)).map((r) => ({ ...r, col: c })); } catch (e) { return []; }
  }))).flat().sort((a, b) => (b.registeredAt || 0) - (a.registeredAt || 0)).slice(0, 12);
  if (!el || !root.isConnected) return;
  if (!recents.length) { el.insertAdjacentHTML("beforeend", '<div class="nf-note">no mints yet</div>'); return; }
  const evOf = (k) => (k === "sale" ? "SOLD" : k === "list" ? "LISTED" : "MINT");
  const actPrice = (r) => (r.kind === "mint" ? priceOf(r.col) : r.price ? fmtSol(r.price) : priceOf(r.col));
  el.insertAdjacentHTML("beforeend", recents.map((r) => `
    <a class="actrow flickrow" href="?view=nft&asset=${esc(r.asset)}">
      <div class="act-l"><img src="${esc(imgUrl(r.inscriptionSig))}" alt="" loading="lazy">
        <div style="min-width:0"><div class="act-name">${esc(r.col.name)} #${r.index}</div>
        <div class="act-sub"><span class="act-ev ${r.kind}">${evOf(r.kind)}</span>${esc(actPrice(r))}</div></div></div>
      <span class="act-time">${fmtWhen(r.registeredAt)}</span>
    </a>`).join(""));
}
