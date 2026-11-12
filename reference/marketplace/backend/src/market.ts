import type { Database } from "bun:sqlite";

// Registry-mirror reads only. No chain scan, metadata download, or unminted art.
export function createMarketCatalog(
  db: Database,
  cluster: string,
  gatewayBase: string,
) {
  const select = `SELECT s.asset,s.slug,s.item_index,s.owner,s.inscription_sig,
      c.core_collection,c.name AS collection_name,COALESCE(i.name,'NFT #'||s.item_index) AS name
    FROM slot s JOIN collection c ON c.slug=s.slug
    LEFT JOIN item i ON i.slug=s.slug AND i.item_index=s.item_index`;
  const all = db.query(select + ` WHERE s.asset>?1 ORDER BY s.asset LIMIT ?2`);
  const collection = db.query(
    select + ` WHERE s.slug=?1 AND s.asset>?2 ORDER BY s.asset LIMIT ?3`,
  );
  const exact = db.query(
    select + ` WHERE s.asset=?1 AND (?2 IS NULL OR s.slug=?2) LIMIT 1`,
  );
  return (query: {
    cursor?: string;
    collection?: string;
    asset?: string;
    limit?: string;
  }) => {
    const cursor = query.cursor ?? "",
      slug = query.collection,
      asset = query.asset;
    if (asset && (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset) || cursor))
      throw new Error("Invalid asset lookup");
    if (cursor && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cursor))
      throw new Error("Invalid market cursor");
    if (slug && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug))
      throw new Error("Invalid collection");
    const limit = query.limit === undefined ? 64 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new Error("Market page limit must be 1..64");
    const rows = (
      asset
        ? exact.all(asset, slug ?? null)
        : slug
          ? collection.all(slug, cursor, limit + 1)
          : all.all(cursor, limit + 1)
    ) as Array<Record<string, string | number>>;
    const more = rows.length > limit,
      page = rows.slice(0, limit);
    return {
      cluster,
      assets: page.map((row) => ({
        asset: row.asset,
        collection: row.core_collection,
        collectionName: row.collection_name,
        slug: row.slug,
        index: row.item_index,
        name: row.name,
        owner: row.owner,
        inscriptionSig: row.inscription_sig,
        image: row.inscription_sig
          ? `${gatewayBase}/img/${row.inscription_sig}.png`
          : null,
      })),
      nextCursor: more ? String(page.at(-1)!.asset) : null,
    };
  };
}
