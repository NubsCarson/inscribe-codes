// Token side (Board v5): markets.exe + the launch-a-token flow, Solana and
// Robinhood in one page (same structure, different accent + launch venue).
// Launch = (1) stage content: text / ascii / image / file, or pick an
// inscription you already own; (2) inscribe it; (3) name it and launch
// (pump.fun on Solana, Pons on Robinhood). A kind=token feed row lists the
// coin in Markets here and on the iqlabs.dev board.
import { typeLabels } from "../../ui/tty.js";
import { skeleton } from "../../ui/skeleton.js";
import { esc, fmtUsd, fmtPct, fmtWhen, shortAddr } from "../../ui/fmt.js";
import { toAscii } from "../../ui/ascii.js";
import { readTokens, readMine, notify, imgUrl, renderUrl, metaUrl, readTokenMeta } from "../../services/gateway.js";
import { marketRows, tradeUrl, tradeLabel } from "../../services/markets.js";
import { connect as rpcConnect } from "../../chain/rpc.js";
import { estimateCost } from "../../chain/burner.js";
import { nav, paintWalletPill as paintNavWallet } from "../../ui/nav.js";

import { PAIRS, IQ_LAUNCH_FEE_SOL, canSetHolderRewardRate } from "../../chain/launch/options.js";

const hasMarketPrice = (row) => Number.isFinite(Number(row.priceUsd)) && Number(row.priceUsd) > 0;

const CAP_KB = 256; // encoded row cap for the in-browser path; bigger goes via the SDK
const SDK_DOCS = "https://iqlabs.mintlify.app/docs-typescript";

// The only place the two chains differ.
const CHAINS = {
  solana: { label: "SOLANA", market: "solana", venue: "pump.fun" },
  hood: { label: "ROBINHOOD", market: "robinhood", venue: "Pons" },
};

const st = {
  chain: "solana",
  sol: { wallet: null, burner: null, mine: null },
  hood: { address: null, mine: null },
  open: false, tab: "text", phase: "menu",
  text: "", staged: null, picked: null,
  ascii: { dataUrl: null, font: 8, spacing: -2, out: "" },
  srcSig: null, srcKind: null,
  name: "", symbol: "", desc: "", launchOptions: null, pumpDraft: null,
  result: null, error: null, progress: 0, stepLabel: "",
  coins: [], priced: {}, info: {},
};
const ch = () => CHAINS[st.chain];

export async function mount(root) {
  root.innerHTML = `
${nav("token")}
<div id="desk" style="padding:14px 16px 48px">
  <div class="win" id="markets">
    <div class="wh"><span data-tty>Markets</span><span class="wh-right" id="tk_count"></span></div>
    <div style="display:flex;gap:18px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--acc);flex-wrap:wrap">
      <div style="flex:0 0 238px;aspect-ratio:7/3;border:1px solid var(--line);overflow:hidden;background:var(--panel)"><img src="public/img/launch_hero.png" alt="" style="width:100%;height:100%;object-fit:cover"></div>
      <div style="flex:1 1 260px;min-width:0">
        <div class="hero" style="font-size:22px" data-tty>Launch a token from an on-chain inscription.</div>
        <div class="sm" style="margin-top:4px;line-height:1.6">Inscribe an image, text, anything, or pick one you already own. Name it, launch it. The coin page links back to the on-chain original forever.</div>
      </div>
      <button class="cta" id="tk_open" style="flex:0 0 auto">&rarr; Launch a token</button>
    </div>
    <div id="tk_tip" style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:7px 14px;border-bottom:1px solid var(--line)"><span class="sm">Click any token to see its chart.</span><span class="sm lnk" id="tk_tipx" style="padding:0 4px">x</span></div>
    <div class="tk-list-head"><span class="sm">Recent launches</span><span class="sm tk-chart-hint">click a card for the chart</span></div>
    <div id="tk_cards" class="ttyrows">${skeleton(6, "tk")}</div>
    <p class="sm" style="margin:0;padding:10px 14px;border-top:1px solid var(--line)">Tokens launched from the feed, biggest first. Prices refresh every 30 seconds when available.</p>
  </div>
</div>
<div id="tk_modal"></div>`;

  typeLabels(root);
  // ?chain=hood (or robinhood) opens the Robinhood board directly; the board
  // links on iqlabs.dev use it. Same reset as switchChain, before the first paint.
  const params = new URLSearchParams(location.search);
  const want = { hood: "hood", robinhood: "hood", solana: "solana" }[params.get("chain")];
  if (want && want !== st.chain) {
    st.chain = want;
    st.open = false; st.picked = null; st.staged = null;
    st.coins = []; st.priced = {};
  }
  paintChainNav(root);
  wireWallet(root);
  root.querySelector("#tk_open").onclick = () => { st.open = true; st.phase = "menu"; st.error = null; paintModal(root); };
  const tipx = root.querySelector("#tk_tipx");
  if (tipx) tipx.onclick = () => { const t = root.querySelector("#tk_tip"); if (t) t.remove(); };

  const modal = root.querySelector("#tk_modal");
  await loadCoins(root);
  const mint = params.get("mint");
  if (mint && modal.isConnected && (!want || want === st.chain) && st.coins.some((coin) => coin.mint === mint)) {
    openChart(root, mint);
  }
  const timer = setInterval(() => loadCoins(root).catch(() => {}), 30000);
  return () => { clearInterval(timer); document.body.removeAttribute("data-net"); };
}

function paintChainNav(root) {
  if (st.chain === "hood") document.body.setAttribute("data-net", "hood");
  else document.body.removeAttribute("data-net");
  const slot = root.querySelector("#nav_chain");
  if (!slot) return;
  const other = st.chain === "solana" ? "hood" : "solana";
  const label = other === "hood" ? "Robinhood" : "Solana";
  slot.innerHTML = `<button class="navbtn2" id="tk_chain" aria-label="Switch to ${label}">${label}<span class="nav-chain-word">&nbsp;chain</span>&nbsp;&rarr;</button>`;
  slot.querySelector("#tk_chain").onclick = () => switchChain(root, other);
}

function switchChain(root, chain) {
  if (st.chain === chain) return;
  st.chain = chain;
  st.launchOptions = null;
  st.open = false; st.picked = null; st.staged = null;
  st.sol.mine = null; st.hood.mine = null;
  st.coins = []; st.priced = {};
  paintChainNav(root);
  paintWalletPill(root);
  root.querySelector("#tk_modal").innerHTML = "";
  root.querySelector("#tk_cards").innerHTML = skeleton(6, "tk");
  loadCoins(root).catch(() => {});
}

// ── wallets (per chain) ─────────────────────────────────────────────────────
async function wireWallet(root) {
  const sol = await import("../../chain/wallets.js");
  st.connectWallet = async () => {
    if (st.chain === "solana") st.sol.wallet = await sol.connect();
    else { const { connectEvm } = await import("../../chain/evm.js"); st.hood.address = await connectEvm(); }
    paintWalletPill(root); paintModal(root);
  };
  st.disconnectWallet = async () => {
    if (st.chain === "solana") { await sol.disconnect(); st.sol.wallet = null; st.sol.burner = null; st.sol.mine = null; }
    else { const { disconnectEvm } = await import("../../chain/evm.js"); disconnectEvm(); st.hood.address = null; st.hood.mine = null; }
    paintWalletPill(root); paintModal(root);
  };
  paintWalletPill(root);
  sol.restore().then((w) => { if (w) { st.sol.wallet = w; paintWalletPill(root); paintModal(root); } });
  import("../../chain/evm.js").then(({ connectEvm }) => connectEvm({ silent: true }).then((a) => { if (a) { st.hood.address = a; paintWalletPill(root); } }).catch(() => {}));
}

const walletAddr = () => (st.chain === "solana" ? (st.sol.wallet ? st.sol.wallet.publicKey.toBase58() : null) : st.hood.address);

const paintWalletPill = (root) => paintNavWallet(root.querySelector("#nav_wallet"), walletAddr(), st.connectWallet, st.disconnectWallet);

// ── markets ─────────────────────────────────────────────────────────────────
async function loadCoins(root) {
  const chain = st.chain;
  let coins;
  // Each coin's real artwork is its own inscription (c.src), served from our
  // gateway right after launch. Market providers (DexScreener / Gecko) fetch
  // that lazily and new or cold coins show no provider icon for a while, so the
  // card must render the on-chain image itself. img = raw image, imgAlt = the
  // render-card fallback for text / ascii inscriptions that have no raw image.
  if (chain === "solana") {
    coins = await readTokens(30);
    for (const c of coins) if (c.src) { c.img = imgUrl(c.src); c.imgAlt = renderUrl(c.src); }
  } else {
    const { readEvmTokens, evmImgUrl, evmRenderUrl } = await import("../../chain/evm.js");
    coins = await readEvmTokens(30);
    for (const c of coins) if (c.src) { c.img = evmImgUrl(c.src); c.imgAlt = evmRenderUrl(c.src); }
  }
  if (st.chain !== chain) return; // switched away mid-load
  st.coins = coins;
  if (coins.length) {
    const priced = await marketRows(CHAINS[chain].market, coins.map((c) => c.mint));
    if (st.chain !== chain) return;
    st.priced = Object.fromEntries(priced.map((p) => [p.mint, p]));
  } else st.priced = {};
  paintCards(root);
}

function paintCards(root) {
  const el = root.querySelector("#tk_cards");
  if (!el || !root.isConnected) return;
  root.querySelector("#tk_count").textContent = st.coins.length + " LAUNCHED · " + ch().label;
  if (!st.coins.length) { el.innerHTML = '<span class="sm">no launches yet on ' + ch().label.toLowerCase() + '. be the first.</span>'; return; }
  const sorted = st.coins.slice().sort((a, b) => ((st.priced[b.mint] || {}).mcap || 0) - ((st.priced[a.mint] || {}).mcap || 0));
  el.innerHTML = sorted.map((c) => {
    const p = st.priced[c.mint] || {};
    const live = Number(p.mcap) > 0;
    const price = Number(p.priceUsd);
    const hasPrice = hasMarketPrice(p);
    return `<div class="flick tkcard" data-mint="${esc(c.mint)}" style="border:1px solid ${live ? "var(--acc)" : "var(--line)"};background:var(--panel);cursor:pointer">
      <div style="aspect-ratio:1;overflow:hidden;background:var(--panel);position:relative">
        ${(p.icon || c.img) ? `<img src="${esc(p.icon || c.img)}" alt="" loading="lazy" ${c.imgAlt ? `onerror="this.onerror=null;this.src='${esc(c.imgAlt)}'"` : ""} style="width:100%;height:100%;object-fit:contain;image-rendering:pixelated">` : `<div class="hero" style="display:grid;place-items:center;height:100%;font-size:28px;color:var(--mut)">$${esc((c.symbol || "?").slice(0, 6))}</div>`}
        ${p.chg24 != null ? `<span class="chip live" style="position:absolute;left:6px;top:6px;background:rgba(0,0,0,.85);color:${p.chg24 >= 0 ? "var(--acc)" : "var(--bad)"}">${fmtPct(p.chg24)}</span>` : ""}
      </div>
      <div style="padding:9px 10px 10px">
        <div style="color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:400 16px 'Jersey 15',monospace">${esc(c.name || "")}</div>
        <div class="sm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">$${esc(c.symbol || "?")}</div>
        <div style="margin-top:6px;display:flex;justify-content:space-between;align-items:baseline"><span class="hero" style="font-size:22px">${live ? fmtUsd(p.mcap) : "—"}</span><span class="sm">MC</span></div>
        <div class="sm" style="margin-top:6px">${hasPrice ? "$" + price.toPrecision(4) : "&nbsp;"}</div>
        <div class="sm" style="margin-top:4px;color:${hasPrice ? "var(--mut)" : "var(--cta)"}">${hasPrice ? esc(p.via || "") : "No price data"}</div>
      </div>
    </div>`;
  }).join("");
  for (const card of el.querySelectorAll(".tkcard")) card.onclick = () => openChart(root, card.dataset.mint);
}

function openChart(root, mint) {
  const c = st.coins.find((x) => x.mint === mint) || {};
  const p = st.priced[mint] || {};
  const chain = ch();
  const modal = root.querySelector("#tk_modal");
  modal.innerHTML = `
<div class="tk_backdrop" style="position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.88);display:flex;align-items:flex-start;justify-content:center;padding:26px 16px;overflow:auto">
  <div class="win" style="width:1120px;max-width:100%;background:var(--bg)">
    <div class="wh"><span data-tty>Chart</span><span style="color:var(--acc)">$${esc(c.symbol || "?")} ${esc(c.name || "")}</span><span class="wh-right">mint: ${esc(shortAddr(mint))}</span><span class="wh-x tk_close">x</span></div>
    <div class="tk_split">
      <aside class="tk_info" data-mint="${esc(mint)}">${infoHtml(c, p, chain, null)}</aside>
      <section style="padding:14px;min-width:0">
        ${p.embed ? `<iframe src="${esc(p.embed)}" style="width:100%;height:480px;border:1px solid var(--line);background:var(--panel)"></iframe>`
          : `<div style="height:480px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:0 20px;text-align:center;border:1px dashed rgba(63,210,79,.3)"><span class="cm" style="color:var(--cta)">Chart unavailable</span><span class="cm">Open ${esc(chain.venue)} to view this token.</span></div>`}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center">
          <a class="cta" style="font-size:16px;padding:8px 14px" href="${esc(tradeUrl(chain.market, mint))}" target="_blank" rel="noopener">${tradeLabel(chain.market)}</a>
          ${p.url ? `<a class="btn2" style="font-size:16px" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.siteLabel || "CHART SITE")}</a>` : ""}
          <span class="btn2 tk_copy" style="font-size:16px" data-copy="${esc(mint)}">COPY MINT</span>
          <span class="btn2 tk_close" style="font-size:16px;margin-left:auto">BACK TO LIST</span>
        </div>
      </section>
    </div>
  </div>
</div>`;
  wireModalClose(modal);
  for (const b of modal.querySelectorAll(".tk_copy")) b.onclick = () => copyText(b, b.dataset.copy);
  typeLabels(modal);
  loadInfo(modal, c, p, chain);
}

// Left pane of the chart modal: what the coin registered on chain. info=null
// paints the head + a skeleton while the description is still loading.
function infoHtml(c, p, chain, info) {
  const live = Number(p.mcap) > 0;
  const hasPrice = hasMarketPrice(p);
  const img = p.icon || c.img;
  const stat = (k, v, color) => `<div class="tk_stat"><span class="lab">${k}</span><span${color ? ` style="color:${color}"` : ""}>${v}</span></div>`;
  const head = `
    <div class="tk_infohead">
      <div class="tk_infoimg">${img ? `<img src="${esc(img)}" alt="" ${c.imgAlt ? `onerror="this.onerror=null;this.src='${esc(c.imgAlt)}'"` : ""}>` : `<div class="hero" style="display:grid;place-items:center;height:100%;font-size:20px;color:var(--mut)">$${esc((c.symbol || "?").slice(0, 6))}</div>`}</div>
      <div style="min-width:0">
        <div style="font:400 22px/1.1 'Jersey 15',monospace;color:var(--ink);word-break:break-word">${esc(c.name || "")}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><span class="chip">$${esc(c.symbol || "?")}</span><span class="chip">${esc(chain.label)}</span><span class="chip ${hasPrice ? "live" : "soon"}">${hasPrice ? "LIVE" : "NO PRICE DATA"}</span></div>
      </div>
    </div>
    <div class="tk_stats">
      ${stat("price", hasPrice ? "$" + Number(p.priceUsd).toPrecision(4) : "—")}
      ${stat("24h", p.chg24 != null ? fmtPct(p.chg24) : "...", p.chg24 == null ? "" : p.chg24 >= 0 ? "var(--acc)" : "var(--bad)")}
      ${stat("market cap", live ? fmtUsd(p.mcap) : "—")}
      ${stat("24h volume", p.vol24 != null ? fmtUsd(p.vol24) : "...")}
    </div>`;
  if (!info) return head + `<div class="skel" style="border:0;margin-top:16px"><div class="b" style="padding:0"><i></i><i style="width:85%"></i><i style="width:60%"></i><i style="width:40%;margin-top:18px"></i><i style="width:70%"></i><i style="width:55%"></i></div></div>`;

  const section = (label, body) => `<div class="tk_sec"><span class="lab">${label}</span>${body}</div>`;
  const isUrl = (u) => /^https?:\/\//i.test(u || "");
  const shown = (u) => String(u).replace(/^https?:\/\//i, "");
  // Registered links: urls open in a new tab, bare handles show as text.
  const links = [];
  for (const [label, v] of [["website", info.website], ["x / twitter", info.twitter], ["telegram", info.telegram], ["discord", info.discord], ["farcaster", info.farcaster], ["launch post", info.external]]) {
    if (!v || links.some((l) => l[1] === v)) continue;
    links.push([label, v]);
  }
  const linkRows = links.map(([label, v]) => isUrl(v)
    ? `<a class="tk_link" href="${esc(v)}" target="_blank" rel="noopener" title="${esc(v)}"><span class="lab">${label}</span><span>${esc(shown(v))} ↗</span></a>`
    : `<div class="tk_kv" title="${esc(v)}"><span class="lab">${label}</span><span>${esc(v)}</span></div>`).join("");
  // On-chain record: the mint, then every attribute the metadata carries.
  const viewer = (sig) => "https://iqlabs.dev/?menu=" + (chain.market === "solana" ? "codein" : "hoodin") + "&post=" + sig;
  const kvRows = [["mint", c.mint, null], ...info.attributes.map(([k, v]) => [k, v, k === "inscription tx" ? viewer(v) : k === "metadata inscription" ? metaUrl(v) : null])]
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v, href]) => href
      ? `<a class="tk_link" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(v)}"><span class="lab">${esc(k)}</span><span>${esc(v)} ↗</span></a>`
      : `<div class="tk_kv" title="${esc(v)}"><span class="lab">${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  return head
    + section("DESCRIPTION", info.description ? `<div class="tk_desc">${esc(info.description)}</div>` : `<span class="cm">no description on record</span>`)
    + section("LINKS", linkRows || `<span class="cm">none registered</span>`)
    + section("ON CHAIN", kvRows);
}

async function loadInfo(modal, c, p, chain) {
  if (!c.mint) return;
  let info = st.info[c.mint];
  if (!info) {
    try {
      info = chain.market === "solana" ? await solanaInfo(c) : await hoodInfo(c);
      st.info[c.mint] = info;
    } catch (e) {
      console.warn("[chart] token info failed:", e.message);
      info = { description: "", attributes: [["inscription tx", c.src]] };
    }
  }
  const aside = modal.querySelector(".tk_info");
  if (aside && aside.dataset.mint === c.mint) aside.innerHTML = infoHtml(c, p, chain, info);
}

// Solana: the launch inscribed a Metaplex-style JSON (c.meta) the coin's uri points at.
async function solanaInfo(c) {
  const m = c.meta ? await readTokenMeta(c.meta) : null;
  if (!m) return { description: "", attributes: [["inscription tx", c.src]] };
  const attributes = (m.attributes || []).map((a) => [a.trait_type, a.value]);
  if (c.meta) attributes.push(["metadata inscription", c.meta]);
  return { description: m.description || "", website: m.website, twitter: m.twitter, telegram: m.telegram, external: m.external_url, attributes };
}

// Robinhood: the Pons token holds its description + socials itself.
async function hoodInfo(c) {
  const [{ readProvider }, { readPonsToken }] = await Promise.all([import("../../chain/evm.js"), import("../../chain/launch/pons.js")]);
  const t = await readPonsToken(readProvider(), c.mint);
  return { ...t, attributes: [["inscription tx", c.src]] };
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = "COPIED";
    setTimeout(() => { btn.textContent = was; }, 1200);
  } catch (e) { console.warn("[chart] copy failed:", e.message); }
}

// ── launch layer ────────────────────────────────────────────────────────────
const TABS = [["text", "TEXT"], ["ascii", "ASCII"], ["image", "IMAGE"], ["file", "FILE"], ["pick", "MY INSCRIPTIONS"]];
const STEP = {
  text: { title: "Step 1 of 2: write your text", img: "step_text",
    blurb: "Your token starts as text written to the chain. Type it here; the coin page will show it forever." },
  ascii: { title: "Step 1 of 2: turn an image into ASCII", img: "step_ascii",
    blurb: "Pick an image and we turn it into ASCII art on chain. Tune the font size and spacing, then launch." },
  image: { title: "Step 1 of 2: pick your image", img: "step_image",
    blurb: "Your token needs an image that lives on chain. Upload a new one, or pick one you already saved under My inscriptions." },
  file: { title: "Step 1 of 2: pick your file", img: "step_file",
    blurb: "Any file can back a token. Up to " + CAP_KB + " KB in the browser; bigger files go through the SDK." },
  pick: { title: "Step 1 of 2: choose a saved inscription", img: "step_pick",
    blurb: "Everything you already inscribed on inscribe.codes or iqlabs.dev shows up here. Pick one and launch it as a token." },
};

function paintModal(root) {
  const modal = root.querySelector("#tk_modal");
  if (!modal || !root.isConnected) return;
  if (!st.open) { modal.innerHTML = ""; return; }
  const body =
    st.phase === "menu" ? menuHtml() :
    st.phase === "inscribing" || st.phase === "launching" ? progressHtml() :
    st.phase === "form" ? formHtml() :
    doneHtml();
  modal.innerHTML = `
<div class="tk_backdrop" style="position:fixed;inset:0;z-index:25;background:rgba(0,0,0,.88);display:flex;align-items:flex-start;justify-content:center;padding:26px 16px;overflow:auto">
  <div class="win" style="width:780px;max-width:100%;background:var(--bg)">
    <div class="wh"><span>Launch a token · ${ch().label}</span><span class="sm wh-right">${st.phase === "menu" ? "step 1 of 2" : st.phase === "form" ? "step 2 of 2" : ""}</span><span class="wh-x tk_close">x</span></div>
    <div style="padding:20px 22px 22px">${body}</div>
  </div>
</div>`;
  wireModalClose(modal, st.phase === "inscribing" || st.phase === "launching");
  wireModalEvents(root, modal);
  typeLabels(modal);
}

// Encoded byte size of whatever is staged on the current tab, or 0.
function stagedBytes() {
  if (st.tab === "text") return st.text.trim() ? new TextEncoder().encode(st.text).length + 80 : 0;
  if (st.tab === "ascii") return st.ascii.out ? new TextEncoder().encode(st.ascii.out).length + 80 : 0;
  return st.staged && st.staged.tab === st.tab ? st.staged.bytes : 0;
}

function sizeLine() {
  const bytes = stagedBytes();
  if (!bytes) return "";
  const kb = (bytes / 1024).toFixed(1) + " KB";
  if (st.chain !== "solana") return kb + " -> 3 signatures (the burner uploads the batches)";
  const e = estimateCost(bytes);
  return kb + " -> " + e.chunks + " chunk" + (e.chunks > 1 ? "s" : "");
}

function detailsHtml() {
  const bytes = stagedBytes();
  if (!bytes) return "";
  const kb = (bytes / 1024).toFixed(1) + " KB";
  const rows = st.chain === "solana"
    ? (() => {
        const e = estimateCost(bytes);
        return [["size", kb], ["parts", e.chunks + " chunk" + (e.chunks > 1 ? "s" : "")],
          ["network fee", (e.network / 1e9).toFixed(5) + " SOL"],
          ["service fee", (e.codeInFee / 1e9).toFixed(5) + " SOL"],
          ["temporary deposit", (e.rent / 1e9).toFixed(5) + " SOL"],
          ["__total", (e.total / 1e9).toFixed(4) + " SOL"]];
      })()
    : [["size", kb], ["wallet signatures", "3 (the burner uploads the batches)"],
       ["__total", (bytes <= 700 ? 0.00024 : 0.00072).toFixed(5) + " ETH + gas"]];
  const body = rows.map(([k, v]) => k === "__total"
    ? `<div class="kv" style="padding:10px 12px 8px;border-top:1px solid var(--line)"><span style="color:var(--ink)">you pay</span><span style="color:var(--acc)">${v}</span></div>`
    : `<div class="kv" style="padding:6px 12px"><span>${k}</span><span style="color:var(--ink2)">${v}</span></div>`).join("");
  return `<details style="margin-top:12px"><summary class="lnk" style="list-style:none;letter-spacing:.1em;padding:6px 0">details &#9656;</summary>
    <div style="margin-top:4px;border:1px solid var(--mut)" class="sm">${body}</div>
    <div class="sm" style="margin-top:10px">Leftover sweeps back to your wallet. File too big? <a href="${SDK_DOCS}" target="_blank" rel="noopener">upload large files from the terminal</a>.</div>
  </details>`;
}

function asciiBox(label, hint, decId, val, incId, note) {
  return `<div style="border:1px solid var(--line);padding:12px 14px">
    <div class="sm" style="display:flex;justify-content:space-between;align-items:baseline"><span>${label}</span><span style="opacity:.6">${hint}</span></div>
    <div style="display:inline-flex;border:1px solid var(--line);overflow:hidden;margin-top:10px;font:400 16px 'Jersey 15',monospace;color:var(--ink)">
      <div id="${decId}" style="width:32px;text-align:center;padding:5px 0;cursor:pointer">-</div>
      <div style="width:46px;text-align:center;padding:5px 0;border-left:1px solid var(--line);border-right:1px solid var(--line);color:var(--acc)">${val}</div>
      <div id="${incId}" style="width:32px;text-align:center;padding:5px 0;cursor:pointer">+</div>
    </div>
    <div class="sm" style="margin-top:8px">${note}</div>
  </div>`;
}

function menuHtml() {
  const tabs = TABS.map(([id, label]) =>
    `<button class="tk_tab chip ${st.tab === id ? "live" : ""}" data-tab="${id}" style="padding:8px 12px;font-size:12px">${label}</button>`).join("");
  const step = STEP[st.tab];
  const dash = "border:1px dashed var(--acc);text-align:center;cursor:pointer;display:block";
  let content = "";
  if (st.tab === "text") {
    content = `<div style="padding:8px;border:1px solid var(--acc);outline:1px dotted var(--acc);outline-offset:3px;background-color:var(--panel2);background-image:radial-gradient(var(--acc) 1px,transparent 1.2px);background-size:5px 5px">
      <textarea id="tk_text" placeholder="gm. on-chain forever." style="width:100%;box-sizing:border-box;min-height:120px;resize:vertical;display:block;background:var(--bg);color:var(--acc);border:1px solid var(--acc);font:400 18px/1.7 'Jersey 15',monospace;padding:14px;outline:none">${esc(st.text)}</textarea>
    </div>`;
  } else if (st.tab === "ascii") {
    content = `
      <label style="${dash};padding:20px">
        <span class="sm" style="font-size:13px">${st.ascii.dataUrl ? "Pick a different image" : "Select image"}</span><br>
        <span class="sm">PNG / JPG / WEBP</span>
        <input id="tk_afile" type="file" accept="image/*" style="display:none">
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
        ${asciiBox("Font size", "5 to 50", "tk_fdec", st.ascii.font, "tk_finc", "Smaller packs in more characters.")}
        ${asciiBox("Spacing", "-50 to 50", "tk_sdec", st.ascii.spacing, "tk_sinc", "Distance between characters.")}
      </div>
      ${st.ascii.out ? `<pre style="margin:12px 0 0;border:1px solid var(--line);padding:14px;font:400 7px/1.15 monospace;color:var(--acc);background:var(--panel2);max-height:240px;overflow:auto">${esc(st.ascii.out)}</pre>` : ""}`;
  } else if (st.tab === "image" || st.tab === "file") {
    const staged = st.staged && st.staged.tab === st.tab ? st.staged : null;
    const prompt = staged ? esc(staged.label) : st.tab === "image" ? "Drop an image here" : "Drop any file here";
    content = `<label style="${dash};padding:26px;font:400 14px/1.9 'Jersey 15',monospace;color:var(--mut)">
      ${prompt}${st.tab === "image" ? `<br><span class="sm">You see a preview before anything is paid.</span>` : ""}
      <input id="tk_file" type="file" ${st.tab === "image" ? 'accept="image/*"' : ""} style="display:none">
    </label>
    ${staged && staged.kind === "image" ? `<img src="${staged.body}" alt="" style="margin-top:10px;max-height:160px;border:1px solid var(--line)">` : ""}
    ${st.tab === "file" ? `<a href="${SDK_DOCS}" target="_blank" rel="noopener" style="margin-top:10px;display:flex;justify-content:space-between;border:1px solid #b07a1a;padding:10px 14px;font:400 11px/1.6 'Silkscreen',monospace;color:var(--mut);text-decoration:none"><span>bigger than ${CAP_KB} KB?</span><span style="color:#b07a1a">upload from the terminal -></span></a>` : ""}`;
  } else {
    content = walletAddr()
      ? `<div id="tk_minelist"><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${skeleton(6, "tk")}</div></div>`
      : `<div class="sm" style="border:1px dashed var(--acc);padding:22px;text-align:center">Connect your wallet to see what you have saved. Anything from inscribe.codes or iqlabs.dev shows up here.<br><br><span class="lnk" id="tk_connect2">Connect wallet</span></div>`;
  }
  const ready = hasContent();
  const goLabel = !walletAddr() ? "Connect wallet" : st.tab === "pick" ? (st.picked ? "Continue with pick ->" : "Pick an inscription to continue") : "Continue -> fund";
  const strip = "background:var(--bg);box-decoration-break:clone;-webkit-box-decoration-break:clone";
  return `
    <div style="position:relative;margin-bottom:12px;height:196px;border:1px solid var(--line);background:var(--panel);overflow:hidden">
      ${step.img ? `<div style="position:absolute;inset:0;image-rendering:pixelated;opacity:.8"><img src="public/img/${step.img}.webp" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>` : ""}
      <div style="position:relative;padding:18px 16px 16px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;justify-content:flex-end;height:196px;box-sizing:border-box">
        <div class="hero" data-tty style="font-size:30px;min-height:1.1em;padding:6px 12px 4px;${strip}">${esc(step.title)}</div>
        <p style="margin:0;max-width:58ch;font:400 15px/1.6 'Jersey 15',monospace;color:var(--ink);padding:4px 12px;${strip}">${esc(step.blurb)}</p>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${tabs}</div>
    <div style="margin-top:12px">${content}</div>
    ${st.tab === "text" || st.tab === "ascii" || (st.staged && st.staged.tab === st.tab) ? `<div class="sm" id="tk_size" style="margin-top:8px">${sizeLine()}</div>` : ""}
    <div id="tk_est">${st.tab === "pick" ? "" : detailsHtml()}</div>
    ${st.error ? `<div class="sm" style="margin-top:10px;color:var(--bad)">${esc(st.error)}</div>` : ""}
    <button id="tk_go" class="cta" style="width:100%;margin-top:14px;text-align:center" ${ready || !walletAddr() ? "" : "disabled"}>${goLabel}</button>
    ${st.picked ? `<div class="sm" style="margin-top:8px;text-align:center">Using ${esc(st.picked.kind)} inscription ${esc(shortAddr(st.picked.__txSignature))} · <span class="lnk" id="tk_clearpick">upload a new one instead</span></div>` : ""}`;
}

function progressHtml() {
  return `
    <div class="hero" data-tty style="font-size:22px">${st.phase === "inscribing" ? "Writing to chain. Keep this tab open." : "Launching..."}</div>
    <div style="margin-top:14px;border:1px solid var(--line);aspect-ratio:7/3;overflow:hidden;background:var(--panel);image-rendering:pixelated"><img src="public/img/step_chain.webp" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:14px" class="sm"><span>Progress</span><span id="tk_steplabel">${esc(st.stepLabel || "preparing")}</span></div>
    <div style="margin-top:6px;border:1px solid var(--acc);padding:3px"><div id="tk_bar" style="height:14px;background:var(--acc);width:${st.progress}%"></div></div>
    <div class="sm" style="margin-top:10px">&gt; keep this tab open until every part lands. ${st.chain === "solana" ? "One approval funds a burner key; everything else signs itself, and leftover sweeps back." : "The burner uploads the batches; you sign 3 small clean transactions, and leftover sweeps back."}</div>`;
}

function feeRecipientRow({ type = "wallet", recipient = "", percent = "" } = {}) {
  const github = type === "github";
  return `<div class="tk-fee-row">
    <label><span class="sm">Recipient type</span><select name="feeType">
      <option value="wallet"${github ? "" : " selected"}>Wallet</option>
      <option value="github"${github ? " selected" : ""}>GitHub</option>
    </select></label>
    <label class="tk-fee-identity"><span class="sm">${github ? "GitHub account" : "Wallet address"}</span>
      <input name="feeRecipient" value="${esc(recipient)}" placeholder="${github ? "Username or URL" : "Solana address"}" spellcheck="false" required></label>
    <label><span class="sm">Share %</span><input type="number" name="feePercent" value="${esc(percent)}" min="0.01" max="100" step="0.01" required></label>
    <button class="btn2" type="button" data-remove-recipient>Remove</button>
  </div>`;
}

function formHtml() {
  const solana = st.chain === "solana";
  const options = st.launchOptions || {};
  const pairs = PAIRS[st.chain];
  const other = options.pair === "custom";
  const field = (label, key, type = "text", attrs = "") =>
    `<label><span class="sm">${label}</span><input name="${key}" type="${type}" value="${esc(options[key] || "")}" ${attrs}></label>`;
  return `
    <div class="big" data-tty>Step 2 of 2: name it and launch</div>
    <form id="tk_form" class="tk-launch-form">
      <div class="tk-form-grid tk-form-identity">
        <label><span class="sm">Name</span><input id="tk_name" value="${esc(st.name)}" maxlength="32" required></label>
        <label><span class="sm">Symbol</span><input id="tk_sym" value="${esc(st.symbol)}" maxlength="${solana ? 13 : 10}" required></label>
      </div>
      <label><span class="sm">Description</span><textarea id="tk_desc" rows="2" ${solana ? "" : 'maxlength="256"'}>${esc(st.desc)}</textarea></label>
      <details class="tk-pair-picker">
        <summary aria-describedby="tk_pair_hint">
          <span class="sm">Trading pair</span>
          <span id="tk_selected_pair">${esc(other ? "Custom address" : pairs.find(([, address]) => address === (options.pair || ""))?.[0] || pairs[0][0])}</span>
          <span class="tk-pair-toggle" aria-hidden="true"></span>
        </summary>
        <div class="tk-pair-search">
          <div class="tk-pair-command">
            <span aria-hidden="true">&gt;</span>
            <input type="search" aria-label="Search pairs" placeholder="Token name, ticker or address" autocomplete="off" spellcheck="false">
            <button type="button" id="tk_pair_clear" aria-label="Clear pair search" hidden>[x]</button>
          </div>
          <div class="tk-pair-results" role="group" aria-label="Matching trading pairs">
            ${pairs.map(([label, address]) => `<button type="button" data-pair="${esc(address)}" aria-pressed="${!other && (options.pair || "") === address}">
              <span class="tk-pair-name">${esc(label)}</span>${address ? `<code title="${esc(address)}">${esc(shortAddr(address))}</code>` : ""}
            </button>`).join("")}
          </div>
          <p class="sm" id="tk_pair_empty" role="status"></p>
          <button type="button" class="tk-pair-custom" data-pair="custom" aria-pressed="${other}"><span aria-hidden="true">[+]</span> Enter a custom address</button>
        </div>
      </details>
      <input type="hidden" name="pair" value="${esc(options.pair || "")}">
      <label id="tk_pair_address" ${other ? "" : "hidden"}>Quote asset ${solana ? "mint" : "contract address"}
        <input name="customPair" value="${esc(options.customPair || "")}" spellcheck="false">
      </label>
      <p id="tk_pair_hint" class="sm">The pair is fixed at launch. ${solana ? "Pump checks mint eligibility." : "Pons checks its allowlist."}</p>
      <div class="tk-form-grid tk-form-buy">
        ${field('<span id="tk_buy_label">Opening buy</span>', "initialBuy", "text", 'inputmode="decimal" placeholder="0"')}
        ${field("X link (optional)", "twitter", "url", 'placeholder="https://x.com/..."')}
      </div>
      ${solana ? "" : field("Minimum coins to receive", "minTokensOut", "text", 'inputmode="decimal"')}
      <details class="tk-launch-advanced" ${options.advanced ? "open" : ""}>
        <summary class="sm">Advanced options</summary>
        <div class="tk-form-grid">
          ${field("Telegram link", "telegram", "url")}
          ${solana ? field("Website", "website", "url") : ""}
          ${solana ? `
            <label><span class="sm">Launch mode</span><select name="mode">
              ${[["holders", "Holder rewards"], ["standard", "Standard"], ["mayhem", "Mayhem"], ["sharing", "Creator fee sharing"], ["agent", "Tokenized agent (unavailable)"]].map(([id,label]) =>
                `<option value="${id}" ${id === "agent" ? "disabled" : ""} ${(options.mode || "holders") === id && id !== "agent" ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
            <fieldset class="tk-fee-editor" aria-describedby="tk_share_help" hidden disabled>
              <legend class="sm">Creator fee recipients</legend>
              <div class="tk-fee-rows">${(options.feeShares || [{ percent: "100" }]).map(feeRecipientRow).join("")}</div>
              <div class="tk-fee-actions"><button class="btn2" type="button" data-add-recipient>Add recipient</button><output class="sm"></output></div>
              <p id="tk_share_help" class="sm">Shares must total 100% and lock at launch. GitHub recipients claim in Pump.fun.</p>
            </fieldset>
            ${field("Holder Rewards rate (bps)", "creatorFee", "number", 'min="0" step="1" placeholder="Venue default"')}
          ` : `
            ${field("Discord link", "discord", "url")}
            ${field("Farcaster link", "farcaster", "url")}
            ${field("Creator fee wallet", "recipient", "text", 'placeholder="Connected wallet"')}
            ${field("Launch configuration ID", "configId", "number", 'min="0" step="1" placeholder="Venue default"')}
            ${field("Creator tax (bps)", "creatorFee", "number", 'min="0" step="1" placeholder="0"')}
            ${field("Opening-tax exempt wallets", "exemptions", "text", 'placeholder="Optional, comma-separated"')}
            <label class="tk-check"><input name="buyback" type="checkbox" ${options.buyback ? "checked" : ""}> Enable buybacks</label>
          `}
        </div>
        <p class="sm">${solana ? "Holder rewards are permanent. Pump currently blocks new agent accounts. SOL and USDC use Pump’s fee schedule. Eligible custom pairs can set a Holder Rewards rate. 100 bps = 1%." : "For an opening buy, set your minimum received. A stock-token buy may need a separate approval for the exact amount."}</p>
      </details>
      <div class="sm tk-launch-cost">
        <div class="kv"><span>${solana ? "IQ launcher fee" : "Pons launch fee"}</span><span>${solana ? IQ_LAUNCH_FEE_SOL + " SOL" : "quoted before signing"}</span></div>
        <div class="kv"><span>opening buy</span><span id="tk_buy_cost"></span></div>
      </div>
      <p class="sm">${solana ? "Inscription and network fees are additional. Larger launches may need a separate lookup table approval and account rent." : "Gas and inscription costs are additional."}</p>
      ${st.error ? `<p class="sm" role="alert" style="color:var(--bad)">${esc(st.error)}</p>` : ""}
      <button id="tk_launch" class="cta" type="submit">Launch on ${ch().venue}</button>
    </form>
    <button class="sm lnk tk-form-back" type="button" id="tk_back">← back</button>`;
}

function doneHtml() {
  const r = st.result;
  return `
    <div style="border:1px solid var(--line);aspect-ratio:7/3;overflow:hidden;background:var(--panel);image-rendering:pixelated"><img src="public/img/step_launched.webp" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>
    <div style="text-align:center;padding:16px 0 4px">
      <div class="hero" style="font-size:48px" data-tty>Launched.</div>
      <div class="big" style="margin-top:12px">$${esc(st.symbol)} · ${esc(st.name)}</div>
      <div class="sm" style="margin-top:8px">mint: ${esc(r.mint)}<br>a kind=token row was inscribed, so it shows in Markets and on the iqlabs.dev board${r.lookupTable ? "<br>Lookup table: " + esc(r.lookupTable) : ""}</div>
    </div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px" class="sm">
      <a class="cta" style="font-size:16px;padding:10px 16px" href="${esc(tradeUrl(ch().market, r.mint))}" target="_blank" rel="noopener">View on ${ch().venue}</a>
      <span class="lnk tk_close" style="align-self:center;border:1px solid var(--line);padding:9px 16px">Open in markets</span>
      <span class="lnk tk_again" style="align-self:center;border:1px solid var(--line);padding:9px 16px">Launch another</span>
    </div>`;
}

// ── wiring + flow ───────────────────────────────────────────────────────────
function wireModalClose(modal, locked) {
  for (const el of modal.querySelectorAll(".tk_close")) el.onclick = () => { st.open = false; modal.innerHTML = ""; };
  const back = modal.querySelector(".tk_backdrop");
  if (back && !locked) back.onclick = (e) => { if (e.target === back) { st.open = false; modal.innerHTML = ""; } };
}

function wireFeeEditor(editor) {
  const rows = editor.querySelector(".tk-fee-rows");
  const add = editor.querySelector("[data-add-recipient]");
  function refresh() {
    let total = 0;
    for (const row of rows.children) {
      const github = row.querySelector('[name="feeType"]').value === "github";
      row.querySelector(".tk-fee-identity span").textContent = github ? "GitHub account" : "Wallet address";
      row.querySelector('[name="feeRecipient"]').placeholder = github ? "Username or URL" : "Solana address";
      row.querySelector("[data-remove-recipient]").hidden = rows.children.length === 1;
      total += Math.round((Number(row.querySelector('[name="feePercent"]').value) || 0) * 100);
    }
    editor.querySelector("output").value = (total / 100) + "% allocated";
    add.disabled = rows.children.length >= 10;
  }
  editor.addEventListener("input", refresh);
  editor.addEventListener("click", event => {
    if (event.target === add) {
      rows.insertAdjacentHTML("beforeend", feeRecipientRow());
      rows.lastElementChild.querySelector('[name="feeType"]').focus();
    } else if (event.target.matches("[data-remove-recipient]")) {
      event.target.closest(".tk-fee-row").remove();
      add.focus();
    } else return;
    refresh();
  });
  refresh();
}

function wireModalEvents(root, modal) {
  for (const b of modal.querySelectorAll(".tk_tab")) b.onclick = () => { st.tab = b.dataset.tab; st.error = null; paintModal(root); };
  const text = modal.querySelector("#tk_text");
  if (text) { text.oninput = () => { st.text = text.value; st.picked = null; refreshEstimate(modal); }; text.focus(); }
  const file = modal.querySelector("#tk_file");
  if (file) file.onchange = () => stageFile(root, file.files[0]);
  const afile = modal.querySelector("#tk_afile");
  if (afile) afile.onchange = () => stageAsciiSource(root, afile.files[0]);
  for (const [id, delta, key] of [["tk_fdec", -1, "font"], ["tk_finc", 1, "font"], ["tk_sdec", -1, "spacing"], ["tk_sinc", 1, "spacing"]]) {
    const b = modal.querySelector("#" + id);
    if (b) b.onclick = () => { st.ascii[key] = Math.max(key === "font" ? 5 : -50, Math.min(50, st.ascii[key] + delta)); renderAscii(root); };
  }
  const c2 = modal.querySelector("#tk_connect2");
  if (c2) c2.onclick = () => st.connectWallet().catch((e) => alert(e.message));
  const clear = modal.querySelector("#tk_clearpick");
  if (clear) clear.onclick = () => { st.picked = null; paintModal(root); };
  const again = modal.querySelector(".tk_again");
  if (again) again.onclick = () => {
    st.phase = "menu"; st.picked = null; st.staged = null; st.text = ""; st.ascii = { dataUrl: null, font: 8, spacing: -2, out: "" };
    st.srcSig = null; st.srcKind = null; st.launchOptions = null; st.pumpDraft = null; st.result = null; st.error = null; st.progress = 0;
    paintModal(root);
  };
  const go = modal.querySelector("#tk_go");
  if (go) go.onclick = () => (walletAddr() ? startInscribe(root) : st.connectWallet().catch((e) => alert(e.message)));
  const form = modal.querySelector("#tk_form");
  if (form) {
    const pair = form.elements.namedItem("pair");
    const custom = form.elements.namedItem("customPair");
    const buy = form.elements.namedItem("initialBuy");
    const buyLabel = form.querySelector("#tk_buy_label");
    const buyCost = form.querySelector("#tk_buy_cost");
    const updateBuyCost = () => {
      const label = PAIRS[st.chain].find(([, address]) => address === pair.value)?.[0];
      const unit = label?.split(" · ").at(-1) || "quote asset";
      buyLabel.textContent = `Opening buy (${unit})`;
      const amount = buy.value.trim() || "0";
      buyCost.textContent = /^\d+(?:\.\d+)?$/.test(amount) ? `${amount} ${unit}` : "—";
    };
    buy.addEventListener("input", updateBuyCost);
    const mode = form.elements.namedItem("mode");
    const updateRewardRate = () => {
      const fee = form.elements.namedItem("creatorFee");
      fee.disabled = !canSetHolderRewardRate(mode.value, pair.value === "custom" ? custom.value.trim() : pair.value);
      fee.closest("label").hidden = fee.disabled;
    };
    const updatePair = () => {
      custom.closest("label").hidden = pair.value !== "custom";
      custom.required = pair.value === "custom";
      updateBuyCost();
      if (mode) updateRewardRate();
    };
    const picker = form.querySelector(".tk-pair-picker");
    const summary = picker.querySelector("summary");
    const search = picker.querySelector("input");
    const clearSearch = picker.querySelector("#tk_pair_clear");
    const empty = picker.querySelector("#tk_pair_empty");
    const choices = [...picker.querySelectorAll("button[data-pair]")];
    const results = choices.filter((button) => button.dataset.pair !== "custom").map((button) => ({
      button,
      searchable: (button.querySelector("span").textContent + " " + button.dataset.pair).toLowerCase(),
    }));
    const filterPairs = () => {
      clearSearch.hidden = !search.value;
      const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      let found = false;
      for (const { button, searchable } of results) {
        button.hidden = !words.every((word) => searchable.includes(word));
        if (!button.hidden) found = true;
      }
      empty.textContent = found ? "" : "No matching pairs.";
    };
    search.oninput = filterPairs;
    clearSearch.onclick = () => { search.value = ""; filterPairs(); search.focus(); };
    picker.addEventListener("toggle", () => {
      if (!picker.open) return;
      search.value = "";
      filterPairs();
      search.focus();
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        picker.open = false;
        summary.focus();
        event.preventDefault();
      } else if (event.target === search && event.key === "Enter") {
        event.preventDefault();
        const matches = results.filter(({ button }) => !button.hidden);
        if (matches.length === 1) matches[0].button.click();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (event.target !== search && !choices.includes(event.target)) return;
        const visible = choices.filter((button) => !button.hidden);
        const current = visible.indexOf(event.target);
        const next = event.key === "ArrowDown" ? visible[current + 1] : visible[current - 1];
        (next || (event.key === "ArrowUp" ? search : visible.at(-1))).focus();
        event.preventDefault();
      }
    });
    for (const button of choices) {
      button.onclick = () => {
        pair.value = button.dataset.pair;
        picker.querySelector("#tk_selected_pair").textContent = pair.value === "custom" ? "Custom address" : button.querySelector("span").textContent;
        for (const choice of choices) choice.setAttribute("aria-pressed", String(choice === button));
        picker.open = false;
        updatePair();
        (pair.value === "custom" ? custom : summary).focus();
      };
    }
    updatePair();
    if (mode) {
      const editor = form.querySelector(".tk-fee-editor");
      wireFeeEditor(editor);
      custom.addEventListener("input", updateRewardRate);
      const updateMode = () => {
        editor.hidden = mode.value !== "sharing";
        editor.disabled = editor.hidden;
      };
      mode.onchange = () => {
        updateMode();
        updateRewardRate();
      };
      updateMode();
    } else {
      const minimum = form.elements.namedItem("minTokensOut");
      const updateBuy = () => {
        minimum.required = Number(buy.value) > 0;
        minimum.disabled = !minimum.required;
        minimum.closest("label").hidden = minimum.disabled;
      };
      buy.oninput = updateBuy;
      updateBuy();
    }
    form.addEventListener("invalid", (event) => {
      const details = event.target.closest("details");
      if (details) details.open = true;
    }, true);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (readForm(root, form)) void startLaunch(root);
    };
    modal.querySelector("#tk_back").onclick = () => {
      readForm(root, form, false);
      st.phase = "menu"; st.error = null; paintModal(root);
    };
  }
  if (st.tab === "pick" && walletAddr() && st.phase === "menu") loadMine(root);
}

function refreshEstimate(modal) {
  const go = modal.querySelector("#tk_go");
  if (go && walletAddr()) go.toggleAttribute("disabled", !hasContent());
  const box = modal.querySelector("#tk_est");
  if (box) box.innerHTML = st.tab === "pick" ? "" : detailsHtml();
  const size = modal.querySelector("#tk_size");
  if (size) size.textContent = sizeLine();
}

function readForm(root, form, validate = true) {
  const data = new FormData(form);
  st.name = form.querySelector("#tk_name").value.trim();
  st.symbol = form.querySelector("#tk_sym").value.toUpperCase().trim();
  st.desc = form.querySelector("#tk_desc").value;
  const options = Object.fromEntries(data);
  options.feeShares = Array.from(form.querySelectorAll(".tk-fee-row"), row => ({
    type: row.querySelector('[name="feeType"]').value,
    recipient: row.querySelector('[name="feeRecipient"]').value.trim(),
    percent: row.querySelector('[name="feePercent"]').value,
  }));
  delete options.feeType;
  delete options.feeRecipient;
  delete options.feePercent;
  const customPair = options.customPair.trim();
  st.launchOptions = { ...options, customPair, advanced: form.querySelector(".tk-launch-advanced").open, buyback: data.has("buyback") };
  if (!validate) return;
  const utf8 = new TextEncoder();
  if (!st.name || !st.symbol || (st.chain === "solana" && (utf8.encode(st.name).length > 32 || utf8.encode(st.symbol).length > 13))) {
    st.error = "Enter a name and symbol within the venue’s length limits.";
  } else if (options.pair === "custom" && !customPair) {
    st.error = "Enter the quote asset address.";
  } else if (options.initialBuy && !/^\d+(?:\.\d+)?$/.test(options.initialBuy)) {
    st.error = "Enter a non-negative initial buy amount.";
  } else if (options.minTokensOut && (!/^\d+(?:\.\d+)?$/.test(options.minTokensOut) || Number(options.minTokensOut) <= 0)) {
    st.error = "Enter a positive minimum number of coins to receive.";
  } else if (options.mode === "agent") {
    st.error = "Pump currently blocks creation of new agent accounts.";
  } else if (options.creatorFee && !/^\d{1,5}$/.test(options.creatorFee)) {
    st.error = "Enter the fee as a whole number of basis points.";
  } else {
    st.error = null;
    return true;
  }
  paintModal(root);
  return false;
}

const hasContent = () =>
  !!st.picked ||
  (st.tab === "text" ? st.text.trim().length > 0 :
   st.tab === "ascii" ? !!st.ascii.out :
   st.staged && st.staged.tab === st.tab);

function stageFile(root, f) {
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const body = reader.result;
    const kb = new TextEncoder().encode(body).length / 1024;
    if (kb > CAP_KB) { st.error = f.name + " is " + kb.toFixed(0) + " KB encoded; the browser cap is " + CAP_KB + " KB. Use the SDK for big files."; st.staged = null; }
    else { st.error = null; st.picked = null; st.staged = { tab: st.tab, kind: st.tab === "image" || f.type.startsWith("image/") ? "image" : "file", body, label: f.name + " · " + kb.toFixed(0) + " KB", bytes: Math.ceil(kb * 1024) }; }
    paintModal(root);
  };
  reader.readAsDataURL(f);
}

function stageAsciiSource(root, f) {
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { st.ascii.dataUrl = reader.result; renderAscii(root); };
  reader.readAsDataURL(f);
}

async function renderAscii(root) {
  if (!st.ascii.dataUrl) { paintModal(root); return; }
  try {
    st.ascii.out = await toAscii(st.ascii.dataUrl, st.ascii.font, st.ascii.spacing);
    st.picked = null;
    st.error = null;
  } catch (e) { st.error = "ascii render failed: " + e.message; }
  paintModal(root);
}

async function loadMine(root) {
  const modal = root.querySelector("#tk_modal");
  const el = modal && modal.querySelector("#tk_minelist");
  if (!el) return;
  const side = st.chain === "solana" ? st.sol : st.hood;
  if (!side.mine) {
    try {
      if (st.chain === "solana") side.mine = (await readMine(walletAddr(), 30)).rows.filter((r) => r.kind !== "token");
      else { const { readEvmMine } = await import("../../chain/evm.js"); side.mine = (await readEvmMine(walletAddr(), 30)).rows.filter((r) => r.kind !== "token"); }
    } catch (e) { el.textContent = "could not load your inscriptions: " + e.message; return; }
  }
  const mine = side.mine;
  if (!mine.length) { el.innerHTML = '<div style="text-align:center;padding:16px 0"><div class="big">Nothing saved yet</div><p class="sm">Upload an image first. It is saved on chain, then you come straight back here to launch it.</p></div>'; return; }
  el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:236px;overflow-y:auto">' + mine.map((r, i) => {
    const isImg = typeof r.body === "string" && r.body.startsWith("data:image/");
    return `<div class="tk_pickit" data-i="${i}" style="border:1px solid ${st.picked === r ? "var(--acc)" : "var(--line)"};cursor:pointer">
      <div style="aspect-ratio:7/4;overflow:hidden;background:var(--panel);display:grid;place-items:center">${isImg ? `<img src="${r.body}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<span class="sm">${esc(r.kind)}</span>`}</div>
      <div style="padding:7px 9px" class="sm"><span class="chip" style="padding:1px 6px">${esc(r.kind)}</span> ${fmtWhen(r.__blockTime)}<div style="margin-top:4px">${esc(shortAddr(r.__txSignature || ""))}</div></div>
    </div>`;
  }).join("") + "</div>";
  for (const it of el.querySelectorAll(".tk_pickit")) it.onclick = () => { st.picked = mine[Number(it.dataset.i)]; st.staged = null; paintModal(root); };
}

function liveProgress(root, pct, label) {
  st.progress = Math.max(st.progress, Math.min(100, pct));
  if (label) st.stepLabel = label;
  const bar = root.querySelector("#tk_bar");
  const lab = root.querySelector("#tk_steplabel");
  if (bar) bar.style.width = st.progress + "%";
  if (lab && label) lab.textContent = label;
  if (!bar) paintModal(root);
}

async function startInscribe(root) {
  if (!hasContent()) return;
  if (st.picked) {
    st.srcSig = st.picked.__txSignature;
    st.srcKind = st.picked.kind;
    st.phase = "form";
    return paintModal(root);
  }
  const kind = st.tab === "text" ? "text" : st.tab === "ascii" ? "ascii" : st.staged.kind;
  const body = st.tab === "text" ? st.text : st.tab === "ascii" ? st.ascii.out : st.staged.body;
  st.phase = "inscribing"; st.progress = 2; st.stepLabel = "preparing"; st.error = null;
  paintModal(root);
  try {
    const who = walletAddr();
    let sig;
    if (st.chain === "solana") {
      liveProgress(root, 4, "deriving your burner key (one signature)");
      const connection = rpcConnect();
      const burner = await ensureSolBurner();
      liveProgress(root, 10, "funding + writing to chain");
      const { inscribeRow } = await import("../../chain/feed.js");
      ({ sig } = await inscribeRow({
        connection, wallet: st.sol.wallet, burner, kind, body, speed: "light",
        onProgress: (p) => liveProgress(root, 10 + Math.round(p * 0.85)),
        onRetry: () => liveProgress(root, st.progress, "paused, retrying (funds are safe in your burner)"),
      }));
      notify(sig, { kind, body, who });
    } else {
      const { inscribeEvm, notifyEvm } = await import("../../chain/evm.js");
      ({ sig } = await inscribeEvm({
        kind, body, who,
        onProgress: (p) => liveProgress(root, 10 + Math.round(p * 0.7)),
        onStatus: (label) => liveProgress(root, st.progress, label),
      }));
      void notifyEvm(sig, { kind, body, who });
    }
    st.srcSig = sig; st.srcKind = kind;
    st.sol.mine = null; st.hood.mine = null;
    st.phase = "form";
  } catch (e) {
    st.phase = "menu";
    st.error = String((e && e.message) || e);
  }
  paintModal(root);
}

async function ensureSolBurner() {
  if (st.sol.burner) return st.sol.burner;
  const { deriveBurner } = await import("../../chain/burner.js");
  st.sol.burner = await deriveBurner((m) => st.sol.wallet.signMessage(m));
  return st.sol.burner;
}

async function startLaunch(root) {
  st.phase = "launching"; st.progress = 5; st.stepLabel = "preparing"; st.error = null;
  paintModal(root);
  try {
    if (st.chain === "solana") await launchSolana(root);
    else await launchHood(root);
    st.phase = "done";
    loadCoins(root).catch(() => {});
  } catch (e) {
    st.phase = "form";
    st.error = String((e && e.message) || e);
  }
  paintModal(root);
}

async function launchSolana(root) {
  const connection = rpcConnect();
  const options = st.launchOptions;
  const { launchOnPump, preparePump } = await import("../../chain/launch/pumpfun.js");
  const terms = await preparePump(connection, { ...options, creator: st.sol.wallet.publicKey, pair: options.pair === "custom" ? options.customPair : options.pair });
  const burner = await ensureSolBurner();
  const who = walletAddr();
  const image = st.srcKind === "image" ? imgUrl(st.srcSig) : renderUrl(st.srcSig);
  const viewLink = "https://iqlabs.dev/?menu=codein&post=" + st.srcSig;
  const meta = {
    name: st.name, symbol: st.symbol,
    description: (st.desc.trim() ? st.desc.trim() + "\n\n" : "") + "fully on-chain: this coin's artwork and metadata are Solana inscriptions. recover them with the IQ SDK from the chain alone. original: " + viewLink,
    image, external_url: viewLink, website: options.website || viewLink, showName: true,
    attributes: [
      { trait_type: "inscription tx", value: st.srcSig },
      { trait_type: "inscription kind", value: st.srcKind },
      ...(terms.holderReward ? [{ trait_type: "rewards", value: "token holders" }] : []),
      ...(terms.shareholders ? [{ trait_type: "creator fees", value: "shared" }] : []),
      ...(terms.buybackBps !== undefined ? [{ trait_type: "agent buyback bps", value: String(terms.buybackBps) }] : []),
      { trait_type: "storage", value: "fully on-chain (solana code-in)" },
      { trait_type: "feed", value: "iq6900-codein-feed-v1 / global-feed" },
    ],
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
  if (options.twitter) meta.twitter = options.twitter;
  if (options.telegram) meta.telegram = options.telegram;
  // Warm the gateway caches: pump fetches uri + image with short timeouts and a
  // cold reassembly (~25s) would cache as a permanent miss.
  try { fetch(image, { mode: "no-cors" }); } catch (e) {}

  liveProgress(root, 10, "inscribing the coin metadata");
  const { inscribeMeta, inscribeRow } = await import("../../chain/feed.js");
  const metadata = JSON.stringify(meta);
  const { advanced, ...launchSettings } = options;
  const key = JSON.stringify([who, st.srcSig, launchSettings, metadata]);
  if (st.pumpDraft?.key !== key) st.pumpDraft = { key };
  const draft = st.pumpDraft;
  if (!draft.metaSig) {
    const { sig } = await inscribeMeta({ connection, wallet: st.sol.wallet, burner, json: metadata });
    draft.metaSig = sig;
  }
  const { metaSig } = draft;
  try { fetch(metaUrl(metaSig), { mode: "no-cors" }); } catch (e) {}

  liveProgress(root, 35, "creating the coin on pump.fun");
  st.result = await launchOnPump({
    connection, wallet: st.sol.wallet, name: st.name, symbol: st.symbol,
    uri: metaUrl(metaSig), terms, draft,
    onStep: (label) => liveProgress(root, Math.min(90, st.progress + 18), label),
  });

  liveProgress(root, 95, "recording the launch on the feed");
  // The coin exists either way; a registry miss is reported, not fatal.
  try {
    const body = JSON.stringify({ mint: st.result.mint, name: st.name, symbol: st.symbol, src: st.srcSig, meta: metaSig });
    const { sig } = await inscribeRow({ connection, wallet: st.sol.wallet, burner, kind: "token", body, speed: "light" });
    notify(sig, { kind: "token", body, who });
  } catch (e) { console.warn("[launch] registry row failed, the coin is live anyway:", e.message); }
}

async function launchHood(root) {
  const { evmSigner, evmImgUrl, evmRenderUrl, inscribeEvmBoard, notifyEvm } = await import("../../chain/evm.js");
  const { launchOnPons, stripUrls, PONS_DESC_MAX } = await import("../../chain/launch/pons.js");
  const who = walletAddr();
  const logo = st.srcKind === "image" ? evmImgUrl(st.srcSig) : evmRenderUrl(st.srcSig);
  const viewLink = "https://iqlabs.dev/?menu=hoodin&post=" + st.srcSig;
  // Pons hides descriptions over 256 chars or containing any url (measured);
  // the recovery pointer rides socials.website instead.
  const description = (stripUrls(st.desc) + " fully on-chain, reassembles via the IQ SDK").trim().slice(0, PONS_DESC_MAX);
  try { fetch(logo, { mode: "no-cors" }); } catch (e) {}

  liveProgress(root, 20, "launching on pons");
  const out = await launchOnPons({
    signer: evmSigner(), name: st.name, symbol: st.symbol, logo, description,
    socials: { twitter: st.launchOptions.twitter, telegram: st.launchOptions.telegram, discord: st.launchOptions.discord, website: viewLink, farcaster: st.launchOptions.farcaster },
    options: { ...st.launchOptions, pair: st.launchOptions.pair === "custom" ? st.launchOptions.customPair : st.launchOptions.pair },
    onStep: (label) => liveProgress(root, Math.min(85, st.progress + 20), label),
  });
  st.result = { mint: out.token, sig: out.txHash };

  liveProgress(root, 92, "recording the launch on the feed");
  try {
    const body = JSON.stringify({ mint: out.token, name: st.name, symbol: st.symbol, src: st.srcSig });
    const { sig } = await inscribeEvmBoard({ kind: "token", body, who });
    void notifyEvm(sig, { kind: "token", body, who });
  } catch (e) { console.warn("[launch] registry row failed, the coin is live anyway:", e.message); }
}
