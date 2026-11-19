import { addr, session } from "./session.js";
import { connect as rpcConnect } from "../../chain/rpc.js";
import { esc, shortAddr } from "../../ui/fmt.js";
import { nftMarketOf } from "../../services/markets.js";
import { isLocal, readMarketState, prepareMarketTrade, submitMarketTrade, SOL_CURRENCY, NVDAX_CURRENCY } from "../../chain/tensor-market.js";

function amountText(baseUnits, decimals, symbol) {
  const value = BigInt(baseUnits), factor = 10n ** BigInt(decimals);
  const fraction = decimals ? (value % factor).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return String(value / factor) + (fraction ? "." + fraction : "") + " " + symbol;
}

const sol = amount => amountText(amount, 9, "SOL");
const actionLabel = { list: "listing", delist: "delisting", buy: "purchase" };

export async function mountMarketCheckout(panel, asset) {
  const initial = rpcConnect();
  if (!panel?.isConnected || !asset.collection || !isLocal(location.href) || !isLocal(initial.rpcEndpoint)) return;
  const response = await fetch("/qa/market-capabilities", { redirect: "error", cache: "no-store" });
  if (!response.ok) return;
  const capability = await response.json();
  if (capability.tradeSettlement !== true || typeof capability.genesis !== "string" ||
      await initial.getGenesisHash() !== capability.genesis || !panel.isConnected || panel.childElementCount) return;
  const stockEnabled = Array.isArray(capability.tradeCurrencies) && capability.tradeCurrencies.includes(NVDAX_CURRENCY.mint);
  const view = panel.closest(".nf-viewer");
  panel.innerHTML = `<section class="nf-vsec">
    <div class="lab nf-vlab">Tensor · Local Surfpool</div>
    <div data-trade-state></div>
    <div data-trade-review></div>
    <p class="cm" data-trade-status role="status"></p>
  </section>`;
  const state = panel.querySelector("[data-trade-state]");
  const review = panel.querySelector("[data-trade-review]");
  const status = panel.querySelector("[data-trade-status]");
  panel.hidden = false;
  async function refresh() {
    const current = await readMarketState(initial, asset);
    if (!panel.isConnected) return;
    const ownerLine = view.querySelector(".nf-vowner");
    if (ownerLine) ownerLine.textContent = shortAddr(current.currentOwner);
    const indexed = view.querySelector("[data-indexed-market]");
    if (indexed) indexed.hidden = true;
    const wallet = addr(), listing = current.listing;
    const external = nftMarketOf("TCOMP").item(asset.asset);
    const display = listing?.currencyInfo
      ? amountText(listing.price, listing.currencyInfo.decimals, listing.currencyInfo.symbol)
      : listing ? listing.price + " base units" : null;
    let action;
    const currencyEnabled = listing?.currency === "SOL" || (stockEnabled && listing?.currency === NVDAX_CURRENCY.mint);
    if (wallet && currencyEnabled && listing.delistSupported && wallet === listing.owner) action = "delist";
    else if (wallet && currencyEnabled && listing.buySupported && wallet !== listing.owner) action = "buy";
    else if (wallet && !listing && wallet === current.currentOwner) action = "list";
    state.innerHTML = listing ? `
      <div class="nf-vkv">
        <span>Verified price</span><b>${esc(display)}</b>
        <span>Currency</span><b title="${esc(listing.currency)}">${esc(listing.currency === "SOL" ? "Native SOL" :
          listing.currency === NVDAX_CURRENCY.mint ? "NVDAx · xStocks" : shortAddr(listing.currency))}</b>
        <span>Seller</span><b>${esc(shortAddr(listing.owner))}</b>
      </div>` : '<p class="cm">No Tensor listing</p>';
    if (!action) {
      if (listing && !listing.buySupported) {
        state.insertAdjacentHTML("beforeend", '<p class="cm">This order is unavailable for local checkout.</p>');
      }
      state.insertAdjacentHTML("beforeend", `<a class="btn2" href="${esc(external)}" target="_blank" rel="noopener">View on Tensor ↗</a>`);
      return;
    }
    state.insertAdjacentHTML("beforeend", `<form class="nf-vsec">
      ${action === "list" ? `
        ${stockEnabled ? '<label>Listing currency<select class="inp" name="currency"><option value="SOL">SOL</option><option value="NVDAx">NVDAx</option></select></label>' : ""}
        <label><span data-price-label>Listing price (SOL)</span><input class="inp" name="price" inputmode="decimal" maxlength="17" required></label>` : ""}
      <button type="submit" class="btn2">Review ${actionLabel[action]}</button>
    </form>`);
    const form = state.querySelector("form");
    const selector = form.elements.currency;
    if (selector) selector.onchange = () => {
      form.querySelector("[data-price-label]").textContent = "Listing price (" + selector.value + ")";
      form.elements.price.value = "";
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (addr() !== wallet) return;
      const price = form.elements.price?.value;
      const currency = selector?.value === "NVDAx" && stockEnabled ? NVDAX_CURRENCY : SOL_CURRENCY;
      const start = form.querySelector("button");
      start.disabled = true;
      review.replaceChildren();
      status.textContent = "Verifying trade…";
      try {
        const reviewed = await prepareMarketTrade(initial, {
          action, asset: asset.asset, collection: asset.collection, actor: wallet, price, currency, listing,
        });
        if (!panel.isConnected || addr() !== wallet) return;
        status.textContent = "";
        form.hidden = true;
        showReview(action, reviewed, form, start, wallet, listing);
      } catch (error) {
        status.textContent = String(error.message || error);
        start.disabled = false;
      }
    };
  }

  function showReview(action, reviewed, form, start, actor, listing) {
    const amount = value => amountText(value, reviewed.currency.decimals, reviewed.currency.symbol);
    const debit = reviewed.estimatedDebitLamports;
    const estimate = debit < 0 ? "Estimated refund" : "Estimated SOL debit";
    review.innerHTML = `<section class="nf-vsec" aria-label="Trade review">
      <div class="lab nf-vlab">Confirm ${actionLabel[action]}</div>
      <div class="nf-vkv">
        <span>Verified price</span><b>${amount(reviewed.ask)}</b>
        ${reviewed.purchaseCap == null ? "" : `<span>Max price + royalty</span><b>${amount(reviewed.purchaseCap)}</b>`}
        ${reviewed.tokenDebit == null ? "" : `<span>Stock fees + royalties</span><b>${amount(reviewed.tokenDebit - reviewed.ask)}</b>
          <span>Total stock debit</span><b>${amount(reviewed.tokenDebit)}</b>`}
        <span>Network fee</span><b>${sol(reviewed.feeLamports)}</b>
        <span>${estimate}</span><b>${sol(Math.abs(debit))}</b>
      </div>
      ${reviewed.currency.mint === NVDAX_CURRENCY.mint ? '<p class="cm">NVDAx amounts use on-chain units. Wallets may show the issuer-adjusted amount.</p>' : ""}
      <div class="nf-vmk">
        <button type="button" class="btn2" data-cancel-trade>Cancel</button>
        <button type="button" class="btn" data-approve-trade>Approve ${actionLabel[action]}</button>
      </div>
    </section>`;
    const approve = review.querySelector("[data-approve-trade]");
    const cancel = review.querySelector("[data-cancel-trade]");
    cancel.onclick = () => { review.replaceChildren(); form.hidden = false; start.disabled = false; };
    approve.onclick = async () => {
      if (addr() !== actor || !session.wallet) return;
      approve.disabled = true;
      cancel.disabled = true;
      const wallet = session.wallet;
      try {
        status.textContent = "Checking price and network fee…";
        const signature = await submitMarketTrade(initial, wallet, reviewed, {
          actor, asset: asset.asset, collection: asset.collection, genesis: capability.genesis, listing,
          isCurrent: () => panel.isConnected && session.wallet === wallet && rpcConnect().rpcEndpoint === initial.rpcEndpoint,
        }, () => { status.textContent = "Approve the reviewed trade in your wallet…"; });
        if (!panel.isConnected) return;
        review.replaceChildren();
        status.textContent = ({ list: "Listing confirmed", delist: "Delisting confirmed", buy: "Purchase confirmed" })[action] + " · " + shortAddr(signature);
        await refresh();
      } catch (error) {
        review.replaceChildren();
        form.hidden = false;
        status.textContent = String(error.message || error);
        start.disabled = false;
      }
    };
  }

  try { await refresh(); }
  catch (error) { status.textContent = String(error.message || error); }
}
