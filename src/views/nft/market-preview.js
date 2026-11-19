import { addr } from "./session.js";
import { connect as rpcConnect } from "../../chain/rpc.js";
import { isLocal, prepareSellerPreview } from "../../chain/tensor-seller-preview.js";

function exactSol(lamports) {
  const amount = BigInt(lamports);
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return String(amount / 1_000_000_000n) + (fraction ? "." + fraction : "") + " SOL";
}

export async function mountSellerPreview(panel, asset, listing) {
  const owner = addr();
  if (!panel?.isConnected || !asset.collection || !owner || owner !== asset.owner ||
      !isLocal(location.href) || !isLocal(rpcConnect().rpcEndpoint)) return;
  const action = listing ? "delist" : "list";
  if (listing && (listing.source !== "TCOMP" || listing.seller !== owner)) return;
  const capability = await fetch("/qa/market-capabilities", { redirect: "error" });
  if (!capability.ok || !(await capability.json()).sellerPreview || !panel.isConnected ||
      addr() !== owner || panel.childElementCount) return;
  panel.innerHTML = `
    <form class="nf-vsec">
      <div class="lab nf-vlab">Local seller preview</div>
      ${action === "list" ? '<label>Listing price (SOL)<input class="inp" name="price" inputmode="decimal" maxlength="17" required></label>' : ""}
      <button type="submit" class="btn2">${action === "list" ? "Review listing" : "Review delisting"}</button>
      <p class="cm" role="status"></p>
    </form>`;
  panel.hidden = false;
  const form = panel.firstElementChild;
  const button = form.querySelector("button"), status = form.querySelector("[role=status]");
  form.onsubmit = async event => {
    event.preventDefault();
    if (addr() !== owner) return;
    const price = form.elements.price?.value;
    button.disabled = true;
    status.textContent = "Preparing unsigned review…";
    try {
      const { feeLamports } = await prepareSellerPreview(rpcConnect(), {
        action, asset: asset.asset, collection: asset.collection, owner, price,
      });
      if (addr() !== owner) throw Error("The connected wallet changed.");
      const heading = action === "list" ? "Listing price " + price + " SOL. " : "Delist this NFT. ";
      status.textContent = heading + "Network fee " + exactSol(feeLamports) + ". Unsigned review ready.";
    } catch (error) {
      status.textContent = String(error.message || error);
    } finally { button.disabled = false; }
  };
}
