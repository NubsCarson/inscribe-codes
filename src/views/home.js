// Entry view: hero, RECENT ticker, the two doors, top 3 collections / tokens.
// Every number on this page is live (nft backend + gateway feed + market data);
// sections render as data arrives, nothing is mocked.
import { type, typeLabels } from "../ui/tty.js";
import { esc, fmtSol, fmtUsd, fmtPct, fmtWhen, shortAddr } from "../ui/fmt.js";
import * as nft from "../services/nft-backend.js";
import { readBoard, readTokens } from "../services/gateway.js";
import { marketRows } from "../services/markets.js";

const HERO = "*inscribe.codes is an inscription-first launchpad. Every NFT and every token here starts as an inscription: the file itself written to the chain. No IPFS, no server, no takedown.";

export async function mount(root) {
  root.innerHTML = `
<div style="max-width:1080px;margin:0 auto;padding:28px 24px 100px;display:flex;flex-direction:column;gap:64px">
  <div class="sm" style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap">
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <a href="?view=home">./</a><a href="?view=nft">NFT</a><a href="?view=token">Token</a>
      <a href="https://iqlabs.mintlify.app/docs-typescript" target="_blank" rel="noopener">Docs</a>
      <a href="https://iqlabs.dev" target="_blank" rel="noopener">iqlabs.dev</a>
    </div>
    <span id="h_wallet"></span>
  </div>

  <div class="home-hero">
    <picture class="home-hero-art"><source media="(max-width: 640px)" srcset="public/img/hero.webp"><img src="public/img/hero-crawl.webp" width="724" height="2172" alt=""></picture>
    <div class="home-hero-copy" style="display:flex;flex-direction:column;gap:14px">
      <div class="sm" data-tty>inscribe.codes · Solana · Robinhood chain:</div>
      <div class="hero" style="min-height:3.6em"><span id="h_hero"></span><span class="ttycur"></span></div>
      <div class="cap" id="h_stat">*loading chain stats*</div>
    </div>
  </div>

  <div style="display:flex;flex-direction:column;gap:10px">
    <div class="sm" data-tty>RECENT:</div>
    <div class="big ticker" id="h_recent">
      <span class="sm">reading the feed...</span>
    </div>
  </div>

  <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="sm" style="font-size:15px">NFT.EXE · <span id="h_nftlive">...</span>:</div>
      <div class="h4band"><img src="public/img/banner_nft.webp" alt=""></div>
      <div class="big" style="font-size:26px">*Launch a collection or mint from one. Every item's image and metadata are inscriptions, the NFT just points at them.</div>
      <div class="cap">collections / market / my nfts / generate art</div>
      <a href="?view=nft" class="h4cta"><span>&rarr; Make an NFT</span></a>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="sm" style="font-size:15px">TOKEN_LAUNCH.EXE · <span id="h_toklive">...</span>:</div>
      <div class="h4band"><img src="public/img/banner_token.webp" alt=""></div>
      <div class="big" style="font-size:26px">*Inscribe an image, text, anything, or pick one you already own. Name it, launch it. The coin page links back to the onchain original forever.</div>
      <div class="cap">inscribe / launch / markets / chart</div>
      <a href="?view=token" class="h4cta"><span>&rarr; Launch a token</span></a>
    </div>
  </div>

  <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="sm" data-tty>Top 3 collections · MINT VOLUME:</div>
      <div id="h_topnft" style="display:flex;flex-direction:column;border-bottom:2px solid var(--acc)"><span class="sm" style="padding:12px 0">loading...</span></div>
      <a href="?view=nft" class="big">All collections</a>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="sm" data-tty>Top 3 tokens · MCAP:</div>
      <div id="h_toptok" style="display:flex;flex-direction:column;border-bottom:2px solid var(--acc)"><span class="sm" style="padding:12px 0">loading...</span></div>
      <a href="?view=token" class="big">Open markets.exe</a>
    </div>
  </div>

  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="sm" data-tty>Related links:</div>
    <div class="big" style="display:flex;flex-wrap:wrap;gap:0 14px">
      <a href="?view=nft">Launch a collection</a><span>/</span>
      <a href="https://iqlabs.mintlify.app/docs-typescript" target="_blank" rel="noopener">SDK / CLI docs</a><span>/</span>
      <a href="https://iqlabs.dev" target="_blank" rel="noopener">iqlabs.dev board</a>
    </div>
  </div>

  <div class="sm" style="border-top:2px solid var(--acc);padding-top:16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span>inscribe.codes · IQ Labs ${new Date().getFullYear()}</span>
    <span>The full inscription board (images, text, audio) lives on iqlabs.dev</span>
  </div>
</div>`;

  typeLabels(root);
  type(root.querySelector("#h_hero"), HERO);
  wireWallet(root.querySelector("#h_wallet"));

  // Three independent loads; each section fills as its data lands.
  loadCollections(root).catch(() => fail(root, "#h_topnft"));
  loadTokens(root).catch(() => fail(root, "#h_toptok"));
  loadRecent(root).catch(() => { root.querySelector("#h_recent").innerHTML = '<span class="sm">feed unavailable</span>'; });
}

const fail = (root, sel) => { root.querySelector(sel).innerHTML = '<span class="sm">unavailable right now</span>'; };

async function wireWallet(el) {
  const { restore, connect, current } = await import("../chain/wallets.js");
  const paint = () => {
    const w = current();
    el.innerHTML = w ? "<span>" + esc(shortAddr(w.publicKey.toBase58())) + "</span>"
      : '<span class="lnk">Connect wallet</span>';
    if (!w) el.querySelector(".lnk").onclick = () => connect().then(paint).catch((e) => alert(e.message));
  };
  paint();
  restore().then((w) => { if (w) paint(); });
}

async function loadCollections(root) {
  const collections = await nft.collections();
  const live = collections.filter((c) => c.minted < c.maxSupply && (!c.endAt || c.endAt * 1000 > Date.now()));
  root.querySelector("#h_nftlive").textContent = live.length + " MINTING NOW";

  const top = collections.slice().sort((a, b) => b.priceLamports * b.minted - a.priceLamports * a.minted).slice(0, 3);
  root.querySelector("#h_topnft").innerHTML = top.map((c, i) => {
    const soldOut = c.minted >= c.maxSupply;
    const status = soldOut ? "Sold out" : "LIVE";
    return `<a href="?view=nft" class="row" style="grid-template-columns:36px 64px minmax(0,1fr) auto;align-items:center">
      <span class="sm">0${i + 1}</span>
      ${c.logo ? `<img src="${esc(c.logo)}" alt="" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--acc)">` : "<span></span>"}
      <span class="big" style="min-width:0"><span>${esc(c.name)}</span><br><span class="cap" style="font-style:normal">${c.minted.toLocaleString()} / ${c.maxSupply.toLocaleString()} minted · ${esc(c.chain || "solana")}</span></span>
      <span class="big" style="text-align:right;white-space:nowrap">${fmtSol(c.priceLamports * c.minted)}<br><span class="sm" style="color:${soldOut ? "var(--mut)" : "var(--acc)"}">${status}</span></span>
    </a>`;
  }).join("") || '<span class="sm" style="padding:12px 0">no collections yet</span>';

  const mintedTotal = collections.reduce((n, c) => n + c.minted, 0);
  statLine.collections = collections.length;
  statLine.mints = mintedTotal;
  paintStat(root);
}

async function loadTokens(root) {
  const tokens = await readTokens(30);
  root.querySelector("#h_toklive").textContent = tokens.length + " LAUNCHED";
  statLine.tokens = tokens.length;
  paintStat(root);

  if (!tokens.length) { root.querySelector("#h_toptok").innerHTML = '<span class="sm" style="padding:12px 0">no launches yet</span>'; return; }
  const priced = await marketRows("solana", tokens.map((t) => t.mint));
  const top = priced.filter((r) => r.mcap).sort((a, b) => b.mcap - a.mcap).slice(0, 3);
  const byMint = Object.fromEntries(tokens.map((t) => [t.mint, t]));
  root.querySelector("#h_toptok").innerHTML = top.map((r, i) => {
    const t = byMint[r.mint] || {};
    return `<a href="?view=token" class="row" style="grid-template-columns:36px 64px minmax(0,1fr) auto;align-items:center">
      <span class="sm">0${i + 1}</span>
      ${r.icon ? `<img src="${esc(r.icon)}" alt="" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--acc)">` : "<span></span>"}
      <span class="big" style="min-width:0"><span>$${esc(t.symbol || "?")}</span> <span style="color:var(--mut)">${esc(t.name || "")}</span><br><span class="cap" style="font-style:normal">from inscription ${esc(shortAddr(t.src || ""))}</span></span>
      <span class="big" style="text-align:right;white-space:nowrap">${fmtUsd(r.mcap)}<br><span class="sm" style="color:${r.chg24 >= 0 ? "var(--acc)" : "var(--bad)"}">${fmtPct(r.chg24)}</span></span>
    </a>`;
  }).join("") || '<span class="sm" style="padding:12px 0">no priced tokens yet</span>';
}

async function loadRecent(root) {
  const rows = (await readBoard(20)).rows;
  const items = [];
  for (const r of rows.slice(0, 20)) {
    if (!r || !r.kind) continue;
    if (r.kind === "token") {
      try { items.push({ when: r.__blockTime, kind: "Token", title: "$" + JSON.parse(r.body).symbol + " launched", href: "?view=token" }); } catch (e) {}
    } else {
      items.push({ when: r.__blockTime, kind: "Inscription", title: r.kind + " · " + shortAddr(r.__txSignature || ""), href: "?view=token" });
    }
    if (items.length >= 6) break;
  }
  const el = root.querySelector("#h_recent");
  el.innerHTML = items.map((it) =>
    `<a href="${it.href}" style="text-decoration:none"><span class="sm">${fmtWhen(it.when)} / ${esc(it.kind)}</span> &nbsp;<span style="text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:2px">${esc(it.title)}</span></a>`,
  ).join("") || '<span class="sm">nothing yet</span>';
  el.classList.add("ttyrows");
  if (items.length) startTicker(el);
}

// RECENT ticker: scroll scrollLeft like an LED signboard. Scrollbar is hidden in
// CSS but the element stays natively scrollable (wheel, touch) plus grab-drag.
// Auto-scroll pauses while the pointer is over it or dragging.
function startTicker(el) {
  const run = () => {
    if (el.scrollWidth <= el.clientWidth + 4) return; // fits, nothing to move
    const n = el.children.length;
    for (let i = 0; i < n; i++) {
      const c = el.appendChild(el.children[i].cloneNode(true));
      c.setAttribute("aria-hidden", "true");
    }
    const period = el.children[n].offsetLeft; // left edge of the first clone = one cycle
    let paused = false, dragging = false, startX = 0, startLeft = 0;
    const wrap = () => {
      if (el.scrollLeft >= period) el.scrollLeft -= period;
      else if (el.scrollLeft < 0) el.scrollLeft += period;
    };
    const frame = () => {
      if (!el.isConnected) return; // home view was replaced
      if (!paused) { el.scrollLeft += 0.4; wrap(); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    el.addEventListener("pointerenter", () => { if (!dragging) paused = true; });
    el.addEventListener("pointerleave", () => { if (!dragging) paused = false; });
    el.addEventListener("pointerdown", (e) => {
      dragging = true; paused = true; startX = e.clientX; startLeft = el.scrollLeft;
      el.classList.add("drag");
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      el.scrollLeft = startLeft - (e.clientX - startX); wrap();
    });
    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false; paused = false; el.classList.remove("drag");
    });
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
  else run();
}

const statLine = { collections: null, tokens: null, mints: null };
function paintStat(root) {
  const parts = [];
  if (statLine.collections != null) parts.push(statLine.collections + " collections");
  if (statLine.tokens != null) parts.push(statLine.tokens + " tokens launched");
  if (statLine.mints != null) parts.push(statLine.mints.toLocaleString() + " mints");
  if (parts.length) root.querySelector("#h_stat").textContent = "*" + parts.join(" · ") + "*";
}
