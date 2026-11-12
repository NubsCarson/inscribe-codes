import { PublicKey } from "@solana/web3.js";
import { lamports } from "@metaplex-foundation/umi";
import {
  deserializeAssetV1,
  deserializeCollectionV1,
} from "@metaplex-foundation/mpl-core";
const rawAccount = (publicKey, info) => ({
  publicKey,
  data: new Uint8Array(info.data),
  owner: info.owner.toBase58(),
  executable: info.executable,
  lamports: lamports(info.lamports),
  rentEpoch: BigInt(info.rentEpoch ?? 0),
});
const core = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

export async function readCoreAssetAndCollection(
  connection,
  asset,
  collection,
) {
  const accounts = await connection.getMultipleAccountsInfo(
    [new PublicKey(asset), new PublicKey(collection)],
    "confirmed",
  );
  if (accounts.some((a) => !a || !a.owner.equals(core)))
    throw Error("Expected on-chain MPL Core asset and collection.");
  return {
    asset: deserializeAssetV1(rawAccount(asset, accounts[0])),
    collection: deserializeCollectionV1(rawAccount(collection, accounts[1])),
  };
}
export async function currentCoreOwners(connection, assets) {
  if (assets.length > 64) throw Error("Read at most 64 assets per page.");
  if (!assets.length) return assets;
  const accounts = await connection.getMultipleAccountsInfo(
    assets.map((a) => new PublicKey(a.asset)),
    "confirmed",
  );
  return assets.map((entry, i) => {
    const info = accounts[i];
    if (!info || !info.owner.equals(core))
      throw Error("Marketplace asset is no longer available.");
    const asset = deserializeAssetV1(rawAccount(entry.asset, info));
    if (
      asset.updateAuthority.type !== "Collection" ||
      asset.updateAuthority.address !== entry.collection
    )
      throw Error("Marketplace collection mismatch.");
    return { ...entry, owner: String(asset.owner) };
  });
}

export function assertOrdinaryTransfer(asset, collection) {
  if (
    [asset, collection].some(
      (record) => record.oracles?.length || record.lifecycleHooks?.length,
    )
  ) {
    throw Error("This NFT requires its collection’s custom trading flow.");
  }
}
