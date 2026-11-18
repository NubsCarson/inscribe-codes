// Launch a collection (design/NFT Launchpad Flow v5 + Art Helper v5): the
// creator wizard. Steps: 0 what are you launching, 1 details, 2 items (art
// helper: generate / hand-craft / folder), 3 check, 4 mint settings, 5 deploy,
// 6 progress, 7 live. Ends in the deploy engine: one funding signature,
// staged progress, resume on interruption.
import { esc, fmtSol, shortAddr } from "../../ui/fmt.js";
import { paintProgress, typeLabels } from "../../ui/tty.js";
import { call } from "../../services/nft-backend.js";
import { connect as rpcConnect, explorerTx } from "../../chain/rpc.js";
import { fileToBitmap, bitmapToImageData, compositeImageData, compositeDataUrl } from "../../ui/image.js";
import { session, addr, connectWallet, ensureBurner, paintWalletPill } from "./session.js";
import { SOL, availableMintCurrencies, formatMintUnits, isStockCurrency, toMintUnits } from "../../chain/nft-currency.js";

const st = {
  step: 0, producer: "generate",
  name: "", symbol: "", slug: "", slugState: null, description: "",
  logoBitmap: null, bannerBitmap: null, logoUrl: "", bannerUrl: "",
  layers: [], sel: 0, supply: 100, mainPicks: null, generated: null, confirm: false, showMeta: false,
  handItems: [], selItem: 0,
  folderItems: null, folderReport: null,
  currency: SOL, currencies: [SOL], priceInput: "0.01", depositSol: "0", royaltyPct: "5", sequential: false,
  deploying: false, pct: 0, phase: "", log: [], error: null, result: null,
};

export function open(root) {
  st.step = 0; st.error = null; st.result = null; st.deploying = false; st.generated = null; st.confirm = false;
  paint(root);
}

const STEPS = ["1 · DETAILS", "2 · ITEMS", "3 · CHECK", "4 · MINT", "5 · DEPLOY", "6 · PROGRESS"];
const TITLES = ["Launch a collection", "Details", "Items", "Check files", "Mint settings", "Deploy", "deploying…", "Live"];
const MODE_LABEL = { generate: "generated", handcraft: "hand-crafted", folder: "uploaded" };
const STOCK_NAMES = new Map([
  ["NVDAx", "NVIDIA"],
  ["NVDA", "NVIDIA"],
  ["BLK", "BlackRock"],
  ["SPY", "SPDR S&P 500 ETF"],
]);
const DEPLOY_FEE = (n) => 10_000_000 + n * 300_000; // backend quotes the exact value at stage

function items() {
  if (st.producer === "generate") return st.generated && st.generated.items;
  if (st.producer === "handcraft") return st.handItems.length ? st.handItems.map((it) => ({ name: it.name, template: { attributes: it.traits }, imageData: () => bitmapToImageData(it.bitmap) })) : null;
  return st.folderItems;
}

function paint(root) {
  const modal = root.querySelector("#nf_modal");
  if (!modal) return;
  const step = st.result ? 7 : st.deploying ? 6 : st.step;
  const body = [choiceHtml, detailsHtml, itemsHtml, checkHtml, settingsHtml, deployHtml, progressHtml, doneHtml][step]();
  const wide = step === 0 || step === 2;
  modal.innerHTML = `
<div class="nf-overlay" id="ns_overlay">
  <div class="nf-wiz ${wide ? "wide" : ""}">
    ${step >= 1 && step <= 6 ? `<div class="nf-stepper">${STEPS.map((s, i) => `<div class="${i + 1 === step ? "on" : ""}">${s}</div>`).join("")}</div>` : ""}
    <div class="win nf-wizwin">
      <div class="wh"><span>${TITLES[step]}</span>${step >= 1 && step <= 5 ? `<span>step ${step} / 6</span>` : step === 6 ? "<span>resumable</span>" : step === 7 ? "<span>authority: you</span>" : ""}<span class="wh-right wh-x ns_close">x</span></div>
      <div class="nf-wizbody">${body}</div>
    </div>
  </div>
  ${st.confirm ? confirmHtml() : ""}
</div>`;
  typeLabels(modal);
  if (st.deploying) paintProgress(modal.querySelector("#ns_bar"), st.pct);
  for (const x of modal.querySelectorAll(".ns_close")) x.onclick = () => { if (!st.deploying) modal.innerHTML = ""; };
  wire(root, modal);
}

const nav = (back, next, nextLabel = "Continue", disabled = false) =>
  `<div class="nf-nav">${back ? '<button class="btn2 ns_back">← Back</button>' : ""}${next ? `<button class="btn ns_next" ${disabled ? "disabled" : ""}>${nextLabel}</button>` : ""}</div>`;
const err = () => (st.error ? `<div class="cm" id="ns_error" style="margin-top:10px;color:var(--bad)">${esc(st.error)}</div>` : "");

// ── step 0: what are you launching ──────────────────────────────────────────
function choiceHtml() {
  if (!addr()) return `
    <div class="nf-center">
      <img src="public/img/connect_wallet.png" alt="" style="width:100%;max-width:560px;image-rendering:pixelated">
      <div data-tty class="nf-h">Connect a wallet to launch a collection</div>
      <div class="cm">The collection and the mint registry end up owned by your wallet, so we need it from the start.</div>
      <button class="nf-connectbig dotbox" id="ns_connect">Connect wallet</button>
    </div>`;
  const card = (p, img, t, s) => `<div class="nf-card ns_pick" data-p="${p}"><div class="nf-cardimg"><img src="${img}" alt=""></div><div class="nf-cardtxt"><span class="t">${t}</span><span class="s">${s}</span></div></div>`;
  return `
    <div data-tty class="nf-h">What are you launching?</div>
    <div class="cm" style="margin-top:6px">Pick how the art comes in. Name and mint settings come next. Everything ends up fully on chain either way.</div>
    <div class="nf-choice">
      ${card("generate", "public/img/choice_gen.webp", "Generate art", "Stack layers, set the count, roll a full set.")}
      ${card("handcraft", "public/img/choice_hand.webp", "Hand-craft 1 / 1", "A few unique pieces, one image each.")}
      ${card("folder", "public/img/choice_upload.png", "Manual upload", "Already have the files? Drop the folder.")}
    </div>`;
}

// ── step 1: details ─────────────────────────────────────────────────────────
function detailsHtml() {
  const slugMsg = st.slugState === "free" ? `<span class="mint">available → inscribe.codes/?view=nft&c=${esc(st.slug)}</span>`
    : st.slugState === "taken" ? '<span style="color:var(--bad)">already taken</span>'
    : st.slugState === "short" ? "3+ chars, a-z 0-9 -" : "set once; this becomes the collection's link";
  const img = (bm, url) => (bm ? `<img src="${url}" alt="">` : "");
  return `
    <div class="nf-form2">
      <div><div class="fl">Collection name</div><input class="inp" id="ns_name" value="${esc(st.name)}" placeholder="Pixel Monks"></div>
      <div><div class="fl">Symbol</div><input class="inp" id="ns_sym" value="${esc(st.symbol)}" maxlength="10" placeholder="MONK"></div>
      <div class="span2"><div class="fl">Collection URL</div>
        <div class="nf-handle"><span>inscribe.codes/?view=nft&c=</span><input class="inp" id="ns_slug" value="${esc(st.slug)}" placeholder="pixel-monks"></div>
        <div class="cm" id="ns_slugmsg" style="margin-top:4px">${slugMsg}</div></div>
      <div class="span2"><div class="fl">Description</div><textarea class="inp" id="ns_desc" style="min-height:64px;resize:vertical">${esc(st.description)}</textarea></div>
      <div><div class="fl">Chain</div><div class="seg lab"><div class="on">◎ Solana</div><div style="opacity:.45;cursor:default" title="coming soon">▲ Robinhood · soon</div></div></div>
      <div><div class="fl">Creator wallet</div><input class="inp" value="${esc(shortAddr(addr()))} (you)" readonly></div>
      <div class="span2"><div class="fl">Logo + banner (optional, inscribed at deploy)</div>
        <div class="nf-brand cm">
          <label>${img(st.logoBitmap, st.logoUrl)}${st.logoBitmap ? "logo set · click to replace" : "+ Logo (square)"}<input id="ns_logo" type="file" accept="image/*" style="display:none"></label>
          <label>${img(st.bannerBitmap, st.bannerUrl)}${st.bannerBitmap ? "banner set · click to replace" : "+ Banner (3 : 1)"}<input id="ns_banner" type="file" accept="image/*" style="display:none"></label>
        </div></div>
    </div>
    <div class="cm" style="margin-top:10px">Name and symbol go on chain with the collection. You can still change the description before deploy.</div>
    ${err()}
    ${nav(true, true)}`;
}

// ── step 2: items (art helper) ──────────────────────────────────────────────
function itemsHtml() {
  const got = items();
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div class="nf-h">${esc(st.name)} <span class="cm">· ${esc(st.symbol)} · ${MODE_LABEL[st.producer]}</span></div>
      <span class="cm lnk ns_method" style="text-decoration:underline">change method</span>
    </div>
    ${st.producer === "generate" ? generateHtml() : st.producer === "handcraft" ? handcraftHtml() : folderHtml()}
    ${err()}
    <div class="nf-nav"><button class="btn2 ns_back">← Back</button>${got && got.length ? `<button class="btn ns_next">Continue with ${got.length} items →</button>` : ""}</div>`;
}

const GHOSTS = ["Background", "Body", "Eyes", "Mouth", "Headwear"];
const traitUrl = (t) => (t.url ||= compositeDataUrl([{ name: "", traits: [t] }], [0], 96));

function generateHtml() {
  if (st.generated) {
    return `
    <div class="ah-done">
      <div style="min-width:0"><div data-tty class="ah-assembled">${st.generated.items.length} items assembled.</div><div class="cm" style="margin-top:6px">Images and details are ready. They go on chain at deploy.</div></div>
      <button class="btn2 ns_regen" style="padding:10px 14px">← Edit layers</button>
    </div>
    <div class="ah-genscroll"><div class="ah-gengrid">${st.generated.previews.map((u) => `<div class="mini" style="cursor:default"><img src="${u}" alt=""></div>`).join("")}</div></div>
    <div class="cm" style="margin-top:8px">Preview of the first ${st.generated.previews.length} of ${st.generated.items.length}. Nothing is on chain yet; that happens at deploy.</div>`;
  }
  if (!st.layers.length) {
    return `
    <div class="ah-empty">
      <div class="lab" style="font-size:16px">Start with a layer</div>
      <div class="cm" style="margin-top:6px">an NFT is assembled from stacked layers, for example:</div>
      <div class="ah-ghosts">${GHOSTS.map((g) => `<div>${g}</div>`).join("")}</div>
      <button class="btn ns_addlayer" style="margin-top:18px;padding:11px 18px;font-size:16px">+ Add your first attribute</button>
    </div>`;
  }
  const L = st.layers[st.sel] || st.layers[0];
  const combos = st.layers.reduce((n, l) => n * Math.max(1, l.traits.length), 1);
  const ready = st.layers.every((l) => l.traits.length);
  if (ready && (!st.mainPicks || st.mainPicks.length !== st.layers.length)) st.mainPicks = st.layers.map((l) => Math.floor(Math.random() * l.traits.length));
  const main = ready ? compositeDataUrl(st.layers, st.mainPicks, 260) : "";
  return `
  <div class="ah-gw">
    <div class="ah-col">
      <div>
        <div class="fl" style="display:flex;justify-content:space-between"><span>Layers</span><span>drag or arrows · top = front</span></div>
        <div style="display:flex;flex-direction:column;gap:6px" id="ns_layers">
          ${st.layers.slice().reverse().map((l, ri) => { const i = st.layers.length - 1 - ri; return `
          <div class="lrow ${i === st.sel ? "on" : ""} ns_lsel" data-i="${i}">
            <div class="grip">${'<span class="gdot"></span>'.repeat(6)}</div>
            <div style="flex:1;min-width:0"><div class="n">${esc(l.name)}</div>
              <div class="sws">${l.traits.slice(0, 6).map((t) => `<span class="sw" style="background-image:url(${traitUrl(t)})"></span>`).join("")}<span class="cm" style="margin-left:4px">${l.traits.length} image${l.traits.length === 1 ? "" : "s"}</span></div></div>
            <div style="display:flex;flex-direction:column;gap:3px"><div class="arw ns_lup ${i === st.layers.length - 1 ? "off" : ""}" data-i="${i}" title="bring forward">↑</div><div class="arw ns_ldn ${i === 0 ? "off" : ""}" data-i="${i}" title="send back">↓</div></div>
          </div>`; }).join("")}
        </div>
        <button class="btn2 ns_addlayer" style="margin-top:8px;padding:8px;font-size:16px;width:100%">+ Add attribute</button>
      </div>
      <div style="border-top:1px solid var(--line);padding-top:12px">
        <div class="fl">Selected attribute</div>
        <input class="inp" id="ns_lname" value="${esc(L.name)}">
        <div style="display:flex;gap:6px;margin-top:10px">
          <label class="ah-drop cm">+ Upload trait images (0.png, 1.png …)<input type="file" class="ns_ltraits" accept="image/*" multiple style="display:none"></label>
          <button class="btn2 ns_lrm" style="padding:10px 12px;font-size:16px">Remove</button>
        </div>
        <div class="cm" style="margin-top:6px">Trait value = the file name. Its images show on the right →</div>
      </div>
    </div>
    <div class="ah-col" style="gap:14px">
      <div>
        <div class="fl" style="display:flex;justify-content:space-between"><span>${esc(L.name)} images</span><span class="cm">${L.traits.length ? "one is picked per item" : "add a few"}</span></div>
        <div class="ah-gal">
          <label class="ah-tile add">+ Image<input type="file" class="ns_ltraits" accept="image/*" multiple style="display:none"></label>
          ${L.traits.map((t, ti) => `<div class="ah-tile"><img src="${traitUrl(t)}" alt=""><div class="n">${esc(t.name)}</div><div class="x ns_trm" data-t="${ti}">×</div></div>`).join("")}
        </div>
      </div>
      <div class="ah-pw">
        <div class="ah-main">${main ? `<img src="${main}" alt="">` : '<span class="cm" style="text-align:center;padding:12px">every layer needs at least one image</span>'}</div>
        <div>
          <div class="fl">LAYER STACK (front → back)</div>
          <div class="ah-legend">${st.layers.slice().reverse().map((l, ri) => { const i = st.layers.length - 1 - ri; const t = ready ? l.traits[st.mainPicks[i]] : null; return `<div><span class="sw" style="${t ? "background-image:url(" + traitUrl(t) + ")" : ""}"></span><b>${esc(l.name)}</b><span>${t ? esc(t.name) : "-"}</span></div>`; }).join("")}</div>
          ${ready ? '<button class="btn2 ns_reroll" style="margin-top:8px;padding:6px 10px;font-size:16px">Re-roll preview</button>' : ""}
          <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
            <div class="fl">How many to generate</div>
            <div style="display:flex;align-items:center;gap:8px"><input class="inp" id="ns_supply" style="width:110px" value="${st.supply}"><span class="cm">of ${combos.toLocaleString("en-US")} possible</span></div>
            <button class="btn ns_gen" style="margin-top:12px;padding:12px;font-size:16px;width:100%" ${ready ? "" : "disabled"}>Generate ${st.supply} items</button>
          </div>
        </div>
      </div>
      <div class="cm">Each item gets one random pick per layer. At deploy the image and its details are saved on chain. One signature does it for all.</div>
    </div>
  </div>`;
}

function handcraftHtml() {
  const it = st.handItems[st.selItem];
  return `
  <div class="ah-hand">
    <div>
      <div class="fl">YOUR 1 / 1 ITEMS · ${st.handItems.length}</div>
      <div class="ah-items">
        ${st.handItems.map((h, i) => `<div class="mini ${i === st.selItem ? "on" : ""} ns_hsel" data-i="${i}"><img src="${h.url}" alt=""><div class="n">${esc(h.name)}</div></div>`).join("")}
        <label class="mini add"><span class="lab" style="font-size:16px;opacity:.7">+ Add<br>Item</span><input id="ns_hadd" type="file" accept="image/*" multiple style="display:none"></label>
      </div>
      <div class="cm" style="margin-top:12px">Each card is one unique item. Drop an image, name it, add traits. Good for a small hand-made drop; use Generate art for big sets.</div>
    </div>
    <div class="ah-edit">
      <div class="fl">Edit item</div>
      ${it ? `
      <div class="ah-prev"><img src="${it.url}" alt=""><label class="btn2">Replace image<input id="ns_hreplace" type="file" accept="image/*" style="display:none"></label></div>
      <div style="margin-top:10px"><div class="fl">Name</div><input class="inp" id="ns_hname" value="${esc(it.name)}"></div>
      <div style="margin-top:10px"><div class="fl">TRAITS (optional)</div>
        <div class="ah-chips">
          ${it.traits.map((t, ti) => `<span class="chip"><span>${esc(t.trait_type)}</span><span class="cm">${esc(t.value)}</span><span class="x ns_htrm" data-t="${ti}">×</span></span>`).join("")}
          <input class="inp" id="ns_htt" placeholder="type" style="width:90px;padding:5px 8px"><input class="inp" id="ns_htv" placeholder="value" style="width:110px;padding:5px 8px"><button class="btn2 ns_htadd" style="padding:7px 10px;font-size:16px">+ Trait</button>
        </div></div>
      <button class="btn2 ns_hrm" style="margin-top:12px;padding:7px 10px;font-size:16px">Remove item</button>` : '<div class="cm">Add an item on the left to edit it here.</div>'}
      <div class="cm" style="margin-top:8px">At deploy each image and its details are saved on chain.</div>
    </div>
  </div>`;
}

function folderHtml() {
  const r = st.folderReport;
  return `
  <div class="ah-box">
    <div class="lab" style="font-size:16px;display:flex;justify-content:space-between"><span>Expected folder format</span><a href="https://docs.scatter.art/creators/metadata" target="_blank" rel="noopener" class="cm">docs.scatter.art/creators/metadata</a></div>
    <div class="cm" style="margin-top:6px;opacity:.65">Media files named by token id (0.png, 1.png, 2.png; 1-based works too). Matching metadata json use the same names (0.json, 1.json); metadata is optional, missing metadata is autogenerated. The json is the OpenSea shape: name, description, image, attributes[].</div>
  </div>
  ${!st.folderItems ? `
  <label class="ah-dz" id="ns_dz">
    <div class="lab" style="font-size:16px">${r && r.error ? r.error : "Drop a folder here to get started"}</div>
    <div class="cm" style="margin-top:6px">images and metadata are parsed and type-checked · click to pick the folder</div>
    <input id="ns_folder" type="file" webkitdirectory multiple style="display:none">
  </label>` : `
  <div class="ah-parsed"><div class="lab mint" style="font-size:16px">FOLDER PARSED · ${r.count} ITEMS · ${r.jsonBad ? "CHECK JSON" : "TYPES OK"}</div><button class="btn2 ns_fclear" style="padding:8px 12px;font-size:16px">Clear</button></div>
  <div class="ah-rep">
    <div><div class="fl">Parse report</div><div class="box">
      <div class="kv"><span>media files</span><span>${r.count} ${esc(r.formats)}, ${r.base}-based</span></div>
      <div class="kv"><span>metadata json</span><span>${r.jsons} found${r.count - r.jsons ? ", " + (r.count - r.jsons) + " missing (autogenerated)" : ""}</span></div>
      <div class="kv"><span>numbering</span><span class="${r.gaps ? "amber" : "mint"}">${r.gaps ? r.gaps + " gaps · renumbered 1.." + r.count : "no gaps ✓"}</span></div>
      <div class="kv"><span>urls to rewrite</span><span class="amber">${r.urls} image fields</span></div>
      <div class="kv"><span>errors</span><span class="${r.jsonBad ? "amber" : "mint"}">${r.jsonBad || 0}</span></div>
    </div></div>
    <div><div class="fl">TYPE CHECK (per item json)</div><div class="box">
      <div class="kv"><span>name</span><span class="mint">string ✓</span></div>
      <div class="kv"><span>description</span><span class="mint">${r.withDesc} with text ✓</span></div>
      <div class="kv"><span>image</span><span class="mint">ignored → becomes on-chain url</span></div>
      <div class="kv"><span>attributes[]</span><span class="mint">${r.withAttrs} with trait_type / value ✓</span></div>
    </div></div>
  </div>
  <div class="ah-box" style="margin-top:12px"><div class="lab amber" style="font-size:16px">Links are updated at deploy</div>
    <div class="cm" style="margin-top:6px;opacity:.7">We inscribe each media file, then rewrite the json's image from the local name / your url to the on-chain gateway url of that inscription, then inscribe the json too. The NFT link points at the inscribed json. Attribute values are plain text, left as is. Your original links are only a staging reference; the minted token resolves fully from chain.</div></div>`}`;
}

function confirmHtml() {
  const n = Math.min(st.supply, st.layers.reduce((c, l) => c * Math.max(1, l.traits.length), 1));
  const samples = Array.from({ length: 5 }, () => compositeDataUrl(st.layers, st.layers.map((l) => Math.floor(Math.random() * l.traits.length)), 96));
  const example = { name: st.name + " #1", description: st.description, image: "gateway.iqlabs.dev/img/<image inscription>.png", attributes: st.layers.map((l) => ({ trait_type: l.name, value: l.traits[0] ? l.traits[0].name : "" })) };
  return `
  <div class="ah-confirm">
    <div class="win nf-wizwin" style="max-width:460px;width:100%">
      <div class="wh"><span data-tty>Confirm</span></div>
      <div class="nf-wizbody" style="padding:20px 22px 22px">
        <div style="color:var(--ink)">Generate ${n.toLocaleString("en-US")} items?</div>
        <p class="cm" style="margin:10px 0 0">// one random pick per layer, no duplicates by trait DNA. Edit layers afterwards and generate again if you want a different set.</p>
        <div style="margin-top:12px"><span class="lnk cm ns_meta" style="color:#b9b3dd">» ${st.showMeta ? "hide" : "show"} example detail file</span>
          ${st.showMeta ? `<div class="ah-meta">${esc(JSON.stringify(example, null, 2))}</div><div class="cm" style="margin-top:6px">One detail file like this is saved per item. The image link points at the on-chain copy.</div>` : ""}</div>
        <div class="ah-samples">${samples.map((u) => `<div class="mini" style="cursor:default"><img src="${u}" alt=""></div>`).join("")}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px"><button class="btn2 ns_cancelgen" style="padding:9px 16px">Cancel</button><button class="btn ns_confirmgen" style="padding:9px 16px">Generate</button></div>
      </div>
    </div>
  </div>`;
}

// ── step 3: check ───────────────────────────────────────────────────────────
function checkHtml() {
  const its = items() || [];
  const n = its.length;
  const longNames = its.filter((it) => (it.name || "").length > 32).length;
  const withTraits = its.filter((it) => it.template && it.template.attributes && it.template.attributes.length).length;
  return `
    <div data-tty class="nf-h">Check results</div>
    <div style="margin-top:12px">
      <div class="kv"><span>items</span><span>${n.toLocaleString("en-US")} · numbers 1 to ${n} · no gaps</span></div>
      <div class="kv"><span>images</span><span>${n} · compressed to 512px webp in your browser at deploy <span class="mint">✓</span></span></div>
      <div class="kv"><span>details</span><span>${n} json · ${withTraits} with traits <span class="mint">✓</span></span></div>
      <div class="kv"><span>collection</span><span>${st.logoBitmap ? "logo ✓" : "no logo (first item is the cover)"} · ${st.bannerBitmap ? "banner ✓" : "no banner"}</span></div>
      <div class="kv"><span>warnings</span><span class="${longNames ? "amber" : ""}">${longNames ? longNames + " names over 32 characters will be shortened" : "none"}</span></div>
      <div class="kv"><span>upload</span><span>${n} images → Arweave in batches of 40 · ${n > 400 ? "roughly " + Math.ceil(n / 400) * 2 + " min" : "a couple of minutes"}</span></div>
    </div>
    ${nav(true, true)}`;
}

// ── step 4: mint settings ───────────────────────────────────────────────────
function settingsHtml() {
  const n = (items() || []).length;
  const stock = isStockCurrency(st.currency);
  const currencies = st.currencies.map(currency => {
    const name = STOCK_NAMES.get(currency.symbol);
    const label = name ? `${currency.symbol} · ${name}` : currency.symbol;
    return `<option value="${esc(currency.mint)}"${currency.mint === st.currency.mint ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
  return `
    <div class="nf-form2">
      <label><div class="fl">Mint currency</div><select class="inp" id="ns_currency">${currencies}</select></label>
      <label><div class="fl">Price (${esc(st.currency.symbol)})</div><input class="inp" id="ns_price" inputmode="decimal" value="${esc(st.priceInput)}"></label>
      <div><div class="fl">Supply</div><input class="inp" value="${n}" readonly></div>
      ${stock ? "" : `<div><div class="fl">Deposit (SOL, paid at reservation, counts toward the price)</div><input class="inp" id="ns_deposit" value="${esc(st.depositSol)}"></div>`}
      <div><div class="fl">Royalties (%)</div><input class="inp" id="ns_royalty" value="${esc(st.royaltyPct)}"></div>
      <div class="span2"><div class="fl">Payout wallet</div><input class="inp" value="${esc(shortAddr(addr()))} (you)" readonly></div>
    </div>
    <div class="nf-opts">
      <div class="nf-opt"><div class="fl">Assignment</div><div class="seg lab"><div class="${st.sequential ? "" : "on"} ns_assign" data-s="0">Random</div><div class="${st.sequential ? "on" : ""} ns_assign" data-s="1">Sequential</div></div></div>
      <div class="nf-opt"><div class="fl">Allowlist phase</div><div class="cm">Mint lists arrive with the manage update. Until then every mint is public.</div></div>
      <div class="nf-opt"><div class="fl">Reveal</div><div class="cm">Instant. Each item is revealed the moment it is minted; delayed reveal is not offered here.</div></div>
    </div>
    <div class="cm" style="margin-top:10px">Buyers pay a 5% platform fee in the mint currency and on-chain costs in SOL. ${stock ? "Stock-priced mints have no reservation deposit. " : ""}The mint currency is fixed at deployment. You pay the deploy fee up front.</div>
    ${err()}
    ${nav(true, true)}`;
}

// ── step 5: deploy ──────────────────────────────────────────────────────────
function deployHtml() {
  const n = (items() || []).length;
  const fee = DEPLOY_FEE(n);
  const est = fee + 20_000_000;
  return `
    <div data-tty class="nf-h">Deploy: one signature, we do the rest</div>
    <div style="margin:18px 0 0;text-align:center;padding:16px 0 6px">
      <div class="nf-bignum">≈ ${(est / 1e9).toFixed(3)} <small>SOL</small></div>
      <div class="cm" style="margin-top:10px">Estimated for ${n} items. The exact amount is computed from your files right before the signature; anything left comes back.</div>
    </div>
    <div class="kv"><span>Mint price</span><span>${formatMintUnits(toMintUnits(st.priceInput, st.currency.decimals), st.currency.decimals)} ${esc(st.currency.symbol)}</span></div>
    <details class="nf-details" style="margin-top:14px"><summary>details ▸</summary><div style="border:1px solid var(--line);margin-top:4px">
      <div class="kv"><span>deploy fee (covers the Arweave staging + platform)</span><span>${fmtSol(fee)}</span></div>
      <div class="kv"><span>manifest + collection.json on chain</span><span>~0.01 SOL</span></div>
      <div class="kv"><span>collection + registry rent, tx fees</span><span>~0.01 SOL <span class="cm">unused part refunded</span></span></div>
      <div class="kv"><span>to</span><span>your burner <span class="cm">(derived from your wallet, swept back after)</span></span></div>
    </div></details>
    <div class="cm" style="margin-top:10px">Your browser compresses and uploads the images first, then asks for the one signature. When it finishes, ${esc(shortAddr(addr()))} holds the collection authority and receives the mint price.</div>
    ${err()}
    <button class="btn ns_deploy" style="margin-top:14px;padding:14px 0;font-size:16px;width:100%">Sign and pay</button>
    <div class="cm ns_back" style="margin-top:12px;text-align:center;cursor:pointer;text-decoration:underline">← back</div>`;
}


function progressHtml() {
  return `
    <div data-tty class="nf-h">Deploying. Keep this tab open until every item lands.</div>
    <div class="ttybar" id="ns_bar" style="margin-top:18px"><progress max="100" aria-label="Deployment progress"></progress><span aria-hidden="true"></span></div><div class="ttyspin cm" id="ns_phase" style="margin-top:6px">${esc(st.phase || "starting")}</div>
    <div class="nf-log" id="ns_log" style="margin-top:16px">${st.log.map((l) => `<div class="${l.ok ? "ok" : ""}">&gt; ${esc(l.text)}</div>`).join("")}</div>
    <div class="cm" style="margin-top:14px">Your browser is doing the writing. If it stops, open the launcher again with the same handle and press Sign and pay: only the missing parts are redone.</div>`;
}

function doneHtml() {
  const r = st.result;
  const link = "inscribe.codes/?view=nft&c=" + r.slug;
  return `
    <div style="text-align:center;padding:14px 0 6px">
      <div class="nf-bignum" data-tty>LIVE.</div>
      <div class="cm" style="margin-top:12px">${esc(st.name)} · ${r.itemCount} items on chain · owner: ${esc(shortAddr(addr()))} (you)</div>
      <div class="mint" style="margin-top:6px">✓ the unused part of the deposit swept back to your wallet</div>
    </div>
    <div class="nf-done3">
      <div><div class="fl" style="margin-bottom:4px">Authority</div>Your wallet holds the collection and the registry; the mint price pays straight to it.</div>
      <div><div class="fl" style="margin-bottom:4px">Share</div>${esc(link)}</div>
      <div><div class="fl" style="margin-bottom:4px">Verify</div>Every item works from the chain alone: open any minted one and run it from chain.</div>
    </div>
    <div class="nf-btnrow lab" style="margin-top:18px">
      <a class="btng" href="?view=nft&c=${esc(r.slug)}">Open collection page →</a>
      <a class="btn2" href="${esc(explorerTx(r.deploySig))}" target="_blank" rel="noopener">Solscan</a>
      <a class="btn2" href="https://x.com/intent/tweet?text=${encodeURIComponent(st.name + " is live, fully on chain: https://" + link)}" target="_blank" rel="noopener">Share on X</a>
    </div>`;
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wire(root, modal) {
  const on = (sel, fn) => { const el = modal.querySelector(sel); if (el) fn(el); };
  const all = (sel, fn) => { for (const el of modal.querySelectorAll(sel)) fn(el); };
  const go = (step) => { st.step = step; st.error = null; paint(root); };
  const back = () => go(st.step - 1);
  const overlay = modal.querySelector("#ns_overlay");
  overlay.onclick = (e) => { if (e.target === overlay && !st.deploying) modal.innerHTML = ""; };

  on("#ns_connect", (el) => { el.onclick = () => connectWallet().then(() => { paintWalletPill(root.querySelector("#nav_wallet")); paint(root); }).catch((e) => alert(e.message)); });
  all(".ns_pick", (el) => { el.onclick = () => { st.producer = el.dataset.p; go(1); }; });
  all(".ns_back", (el) => { el.onclick = back; });
  all(".ns_method", (el) => { el.onclick = () => go(0); });
  all(".ns_next", (el) => { el.onclick = () => {
    if (st.step === 1) {
      if (!st.name.trim() || !st.symbol.trim() || st.slug.length < 3) { st.error = "name, symbol and a 3+ char handle are required"; return paint(root); }
      if (st.slugState === "taken") { st.error = 'the handle "' + st.slug + '" is taken'; return paint(root); }
    }
    if (st.step === 3) {
      go(4);
      const settings = root.querySelector("#ns_currency");
      availableMintCurrencies().then((currencies) => {
        if (st.step !== 4 || !settings?.isConnected) return;
        st.currencies = currencies;
        st.currency = currencies.find(c => c.mint === st.currency.mint) || SOL;
        paint(root);
      }).catch(() => {});
      return;
    }
    if (st.step === 4) {
      try {
        const price = toMintUnits(st.priceInput, st.currency.decimals);
        if (isStockCurrency(st.currency) && !price) throw new Error("Enter a positive stock-token price. Choose SOL for a free mint.");
        if (!isStockCurrency(st.currency) && toMintUnits(st.depositSol, SOL.decimals) > price) throw new Error("Deposit cannot exceed the mint price.");
      } catch (error) { st.error = error.message; return paint(root); }
    }
    go(st.step + 1);
  }; });

  // step 1
  on("#ns_name", (el) => { el.oninput = () => { st.name = el.value; }; });
  on("#ns_sym", (el) => { el.oninput = () => { st.symbol = el.value.toUpperCase(); }; });
  on("#ns_desc", (el) => { el.oninput = () => { st.description = el.value; }; });
  on("#ns_slug", (el) => { el.oninput = () => { st.slug = el.value.toLowerCase().replace(/[^a-z0-9-]/g, ""); if (el.value !== st.slug) el.value = st.slug; checkSlug(modal); }; });
  on("#ns_logo", (el) => { el.onchange = async () => { if (el.files[0]) { st.logoBitmap = await fileToBitmap(el.files[0]); st.logoUrl = URL.createObjectURL(el.files[0]); paint(root); } }; });
  on("#ns_banner", (el) => { el.onchange = async () => { if (el.files[0]) { st.bannerBitmap = await fileToBitmap(el.files[0]); st.bannerUrl = URL.createObjectURL(el.files[0]); paint(root); } }; });

  // step 2: generate
  all(".ns_addlayer", (el) => { el.onclick = () => { st.layers.push({ name: "Attribute " + (st.layers.length + 1), traits: [] }); st.sel = st.layers.length - 1; st.mainPicks = null; paint(root); }; });
  all(".ns_lsel", (el) => { el.onclick = (e) => { if (e.target.closest(".arw")) return; st.sel = Number(el.dataset.i); paint(root); }; });
  // Layers draw back to front in index order, so the list shows the last
  // index on top: up = bring forward, down = send back.
  const moveLayer = (i, to) => { st.layers.splice(to, 0, st.layers.splice(i, 1)[0]); st.sel = to; st.mainPicks = null; paint(root); };
  all(".ns_lup", (el) => { el.onclick = () => { const i = Number(el.dataset.i); if (i < st.layers.length - 1) moveLayer(i, i + 1); }; });
  all(".ns_ldn", (el) => { el.onclick = () => { const i = Number(el.dataset.i); if (i > 0) moveLayer(i, i - 1); }; });
  // Grip drag: the row follows the pointer through the list (DOM only), and
  // the new top-to-bottom order is committed on release. Listeners sit on the
  // document, not the grip: moving the row re-inserts it, which would drop a
  // pointer capture. The grip has touch-action none so a finger drags, not scrolls.
  all(".lrow .grip", (grip) => { grip.onpointerdown = (e) => {
    const row = grip.closest(".lrow"), list = row.parentElement;
    const from = Number(row.dataset.i), id = e.pointerId;
    e.preventDefault(); row.classList.add("dragging");
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      for (const other of list.querySelectorAll(".lrow")) {
        if (other === row) continue;
        const r = other.getBoundingClientRect(), mid = r.top + r.height / 2;
        const before = row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (before && ev.clientY > mid) other.after(row);
        else if (!before && ev.clientY < mid) other.before(row);
      }
    };
    const done = (ev) => {
      if (ev.pointerId !== id) return;
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", done); document.removeEventListener("pointercancel", done);
      const topToBottom = [...list.querySelectorAll(".lrow")].map((r) => Number(r.dataset.i));
      const was = st.layers;
      st.layers = topToBottom.slice().reverse().map((i) => was[i]);
      st.sel = st.layers.indexOf(was[from]); st.mainPicks = null; paint(root);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", done); document.addEventListener("pointercancel", done);
  }; });
  on("#ns_lname", (el) => { el.oninput = () => { st.layers[st.sel].name = el.value; const row = modal.querySelector(`.ns_lsel[data-i="${st.sel}"] .n`); if (row) row.textContent = el.value; }; });
  all(".ns_ltraits", (inp) => { inp.onchange = async () => {
    const l = st.layers[st.sel];
    for (const f of inp.files) l.traits.push({ name: f.name.replace(/\.[^.]+$/, ""), bitmap: await fileToBitmap(f) });
    st.mainPicks = null; paint(root);
  }; });
  all(".ns_trm", (el) => { el.onclick = () => { st.layers[st.sel].traits.splice(Number(el.dataset.t), 1); st.mainPicks = null; paint(root); }; });
  all(".ns_lrm", (el) => { el.onclick = () => { st.layers.splice(st.sel, 1); st.sel = Math.max(0, st.sel - 1); st.mainPicks = null; paint(root); }; });
  all(".ns_reroll", (el) => { el.onclick = () => { st.mainPicks = null; paint(root); }; });
  on("#ns_supply", (el) => { el.oninput = () => { st.supply = Math.max(1, Math.min(10000, parseInt(el.value) || 0)); const b = modal.querySelector(".ns_gen"); if (b) b.textContent = "Generate " + st.supply + " items"; }; });
  all(".ns_gen", (el) => { el.onclick = () => { st.confirm = true; st.showMeta = false; paint(root); }; });
  all(".ns_cancelgen", (el) => { el.onclick = () => { st.confirm = false; paint(root); }; });
  all(".ns_meta", (el) => { el.onclick = () => { st.showMeta = !st.showMeta; paint(root); }; });
  all(".ns_confirmgen", (el) => { el.onclick = () => { st.confirm = false; generate(); paint(root); }; });
  all(".ns_regen", (el) => { el.onclick = () => { st.generated = null; paint(root); }; });

  // step 2: hand-craft
  on("#ns_hadd", (el) => { el.onchange = async () => {
    for (const f of el.files) st.handItems.push({ bitmap: await fileToBitmap(f), url: URL.createObjectURL(f), name: f.name.replace(/\.[^.]+$/, ""), traits: [] });
    st.selItem = st.handItems.length - 1; paint(root);
  }; });
  all(".ns_hsel", (el) => { el.onclick = () => { st.selItem = Number(el.dataset.i); paint(root); }; });
  on("#ns_hreplace", (el) => { el.onchange = async () => { const f = el.files[0]; if (!f) return; const it = st.handItems[st.selItem]; it.bitmap = await fileToBitmap(f); it.url = URL.createObjectURL(f); paint(root); }; });
  on("#ns_hname", (el) => { el.oninput = () => { st.handItems[st.selItem].name = el.value; const n = modal.querySelector(`.ns_hsel[data-i="${st.selItem}"] .n`); if (n) n.textContent = el.value; }; });
  all(".ns_htadd", (el) => { el.onclick = () => {
    const t = modal.querySelector("#ns_htt").value.trim(), v = modal.querySelector("#ns_htv").value.trim();
    if (!t || !v) return;
    st.handItems[st.selItem].traits.push({ trait_type: t, value: v }); paint(root);
  }; });
  all(".ns_htrm", (el) => { el.onclick = () => { st.handItems[st.selItem].traits.splice(Number(el.dataset.t), 1); paint(root); }; });
  all(".ns_hrm", (el) => { el.onclick = () => { st.handItems.splice(st.selItem, 1); st.selItem = Math.max(0, st.selItem - 1); paint(root); }; });

  // step 2: folder
  on("#ns_folder", (el) => { el.onchange = () => parseFolder(root, el.files); });
  on("#ns_dz", (el) => {
    el.ondragover = (e) => { e.preventDefault(); el.classList.add("over"); };
    el.ondragleave = () => el.classList.remove("over");
    el.ondrop = (e) => { e.preventDefault(); el.classList.remove("over"); parseFolder(root, e.dataTransfer.files); };
  });
  all(".ns_fclear", (el) => { el.onclick = () => { st.folderItems = null; st.folderReport = null; paint(root); }; });

  // step 4
  on("#ns_currency", (el) => { el.onchange = () => {
    st.currency = st.currencies.find(c => c.mint === el.value) || SOL;
    st.priceInput = "";
    st.error = null;
    paint(root);
  }; });
  const clearPriceError = () => { st.error = null; modal.querySelector("#ns_error")?.remove(); };
  on("#ns_price", (el) => { el.oninput = () => { st.priceInput = el.value; clearPriceError(); }; });
  on("#ns_deposit", (el) => { el.oninput = () => { st.depositSol = el.value; clearPriceError(); }; });
  on("#ns_royalty", (el) => { el.oninput = () => { st.royaltyPct = el.value; }; });
  all(".ns_assign", (el) => { el.onclick = () => { st.sequential = el.dataset.s === "1"; paint(root); }; });

  // step 5
  all(".ns_deploy", (el) => { el.onclick = () => runDeploy(root); });
}

let slugTimer = null;
function checkSlug(modal) {
  const msg = modal.querySelector("#ns_slugmsg");
  clearTimeout(slugTimer);
  if (st.slug.length < 3) { st.slugState = "short"; if (msg) msg.textContent = "3+ chars, a-z 0-9 -"; return; }
  const checking = st.slug;
  if (msg) msg.textContent = "checking…";
  slugTimer = setTimeout(async () => {
    const r = await call("/c/" + checking).catch(() => null);
    if (st.slug !== checking) return;
    st.slugState = r && r.status === 200 ? "taken" : "free";
    if (msg) msg.innerHTML = st.slugState === "taken" ? '<span style="color:var(--bad)">already taken</span>' : '<span class="mint">available → inscribe.codes/?view=nft&c=' + esc(checking) + "</span>";
  }, 350);
}

function generate() {
  const layers = st.layers;
  const combos = layers.reduce((n, l) => n * Math.max(1, l.traits.length), 1);
  const supply = Math.min(st.supply, combos);
  const seen = new Set();
  const dnas = [];
  for (let guard = 0; dnas.length < supply && guard < supply * 50; guard++) {
    const picks = layers.map((l) => Math.floor(Math.random() * l.traits.length));
    const dna = picks.join(",");
    if (seen.has(dna)) continue;
    seen.add(dna);
    dnas.push(picks);
  }
  // snapshot the layer set so later edits cannot shift what deploy composites
  const snapshot = layers.map((l) => ({ name: l.name, traits: l.traits.slice() }));
  st.generated = {
    items: dnas.map((picks, i) => ({
      name: st.name + " #" + (i + 1),
      template: { attributes: snapshot.map((l, li) => ({ trait_type: l.name, value: l.traits[picks[li]] ? l.traits[picks[li]].name : "" })) },
      imageData: () => compositeImageData(snapshot, picks), // lazy: one composite at a time at deploy
    })),
    previews: dnas.slice(0, 18).map((picks) => compositeDataUrl(snapshot, picks, 96)),
  };
  st.error = st.supply > combos ? "only " + combos + " unique combinations exist; generated " + dnas.length : null;
}

async function parseFolder(root, files) {
  const imgs = new Map(), jsons = new Map(), formats = new Set();
  for (const f of files) {
    const m = f.name.match(/^(\d+)\.(png|jpe?g|webp|gif|json)$/i);
    if (!m) continue;
    const n = parseInt(m[1]);
    if (/json/i.test(m[2])) jsons.set(n, f); else { imgs.set(n, f); formats.add(m[2].toLowerCase()); }
  }
  if (!imgs.size) { st.folderItems = null; st.folderReport = { error: "no N.png / N.jpg files found at the folder root" }; return paint(root); }
  const keys = [...imgs.keys()].sort((a, b) => a - b);
  const base = keys[0];
  const gaps = keys.filter((k, i) => k !== base + i).length;
  const out = [];
  let jsonBad = 0, withDesc = 0, withAttrs = 0, urls = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const bitmap = await fileToBitmap(imgs.get(k));
    let meta = {};
    if (jsons.has(k)) {
      try { meta = JSON.parse(await jsons.get(k).text()); } catch (e) { jsonBad++; meta = {}; }
      if (meta.description) withDesc++;
      if (Array.isArray(meta.attributes) && meta.attributes.length) withAttrs++;
      if (meta.image) urls++;
    }
    out.push({
      index: i + 1,
      name: meta.name || st.name + " #" + (i + 1),
      template: { ...(meta.description ? { description: meta.description } : {}), attributes: Array.isArray(meta.attributes) ? meta.attributes : [] },
      imageData: () => bitmapToImageData(bitmap),
    });
  }
  st.folderItems = out;
  st.folderReport = { count: out.length, formats: [...formats].join("/"), base, jsons: jsons.size, gaps, jsonBad, withDesc, withAttrs, urls };
  paint(root);
}

// deploy stages -> bar position + one log line each
const STAGES = {
  compress: (x) => [2 + Math.round((x.done / x.total) * 38), "compressing " + x.done + " / " + x.total, false],
  stage: (x) => [4 + Math.round((x.done / x.total) * 38), "uploading " + x.done + " / " + x.total + " to Arweave", false],
  funding: () => [46, "approve the funding transfer in your wallet…", false],
  manifest: () => [52, "manifest inscribed on Solana", true],
  logo: () => [66, "logo inscribed", true],
  banner: () => [70, "banner inscribed", true],
  collection: () => [74, "collection.json inscribed", true],
  deploy: () => [85, "collection + registry created in one transaction", true],
  finalize: () => [95, "registry recorded, leftover sweeping back", true],
};

async function runDeploy(root) {
  if (st.deploying) return;
  if (!addr()) { try { await connectWallet(); } catch (e) { st.error = e.message; } return paint(root); }
  const its = items();
  if (!its || !its.length) { st.error = "no items"; st.step = 2; return paint(root); }
  st.deploying = true; st.error = null; st.pct = 1; st.phase = "starting"; st.log = [];
  paint(root);
  const live = (s, x) => {
    const line = STAGES[s];
    if (!line) return;
    const [pct, text, keep] = line(x || {});
    st.pct = Math.max(st.pct, pct); st.phase = text;
    if (keep) st.log.push({ text, ok: true });
    else if (s === "funding") st.log.push({ text, ok: false });
    const b = root.querySelector("#ns_bar"), ph = root.querySelector("#ns_phase"), lg = root.querySelector("#ns_log");
    if (b) paintProgress(b, st.pct);
    if (ph) ph.textContent = text;
    if (lg) lg.innerHTML = st.log.map((l) => `<div class="${l.ok ? "ok" : ""}">&gt; ${esc(l.text)}</div>`).join("");
  };
  try {
    if (isStockCurrency(st.currency) && !(await availableMintCurrencies()).some(
      currency => currency.mint === st.currency.mint && currency.decimals === st.currency.decimals,
    )) throw new Error("Stock checkout is unavailable for the selected currency.");
    const connection = rpcConnect();
    const burner = await ensureBurner();
    const spec = {
      slug: st.slug, name: st.name.trim(), symbol: st.symbol.trim(), description: st.description.trim(),
      price: toMintUnits(st.priceInput, st.currency.decimals), currency: st.currency.mint,
      deposit: isStockCurrency(st.currency) ? 0 : toMintUnits(st.depositSol, SOL.decimals),
      royaltyBps: Math.round(parseFloat(st.royaltyPct || "0") * 100) || 0,
      sequential: st.sequential,
      logo: st.logoBitmap ? () => bitmapToImageData(st.logoBitmap) : null,
      banner: st.bannerBitmap ? () => bitmapToImageData(st.bannerBitmap, 1024) : null,
    };
    const { deploy } = await import("../../chain/nft-deploy.js");
    st.result = await deploy({ connection, wallet: session.wallet, burner, spec, items: its, onStage: live });
  } catch (e) {
    st.error = String((e && e.message) || e) + " · Sign and pay again resumes where it stopped.";
    st.deploying = false;
    st.step = 5;
    return paint(root);
  }
  st.deploying = false;
  paint(root);
}
