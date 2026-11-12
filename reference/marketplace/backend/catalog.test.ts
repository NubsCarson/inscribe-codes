import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createMarketCatalog } from "./src/market.ts";
function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE collection(slug TEXT PRIMARY KEY,core_collection TEXT,name TEXT);CREATE TABLE item(slug TEXT,item_index INTEGER,name TEXT);CREATE TABLE slot(asset TEXT,slug TEXT,item_index INTEGER,owner TEXT,inscription_sig TEXT);CREATE INDEX slot_asset_idx ON slot(asset);",
  );
  for (const slug of ["one", "two"])
    db.query("INSERT INTO collection VALUES(?,?,?)").run(
      slug,
      slug + "-collection",
      slug + " collection",
    );
  for (let i = 1; i <= 132; i++) {
    const asset =
      "1".repeat(31) +
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26));
    db.query("INSERT INTO slot VALUES(?,?,?,?,?)").run(
      asset,
      i % 2 ? "one" : "two",
      i,
      "owner",
      "public-signature",
    );
    if (i !== 132)
      db.query("INSERT INTO item VALUES(?,?,?)").run(
        i % 2 ? "one" : "two",
        i,
        "Item " + i,
      );
  }
  return {
    db,
    page: createMarketCatalog(db, "devnet", "https://dev-gateway.iqlabs.dev"),
  };
}
test("bounded keyset pages cover minted assets across collections without chain reads", () => {
  const f = fixture();
  const first = f.page({});
  expect(first.assets.length).toBe(64);
  const second = f.page({ cursor: first.nextCursor! });
  const third = f.page({ cursor: second.nextCursor! });
  expect(third.assets.length).toBe(4);
  expect(third.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.assets, ...second.assets, ...third.assets].map((a) => a.asset),
    ).size,
  ).toBe(132);
  expect(first.cluster).toBe("devnet");
  expect(first.assets[0]!.image).toStartWith(
    "https://dev-gateway.iqlabs.dev/img/",
  );
  f.db.close();
});
test("collection filter and single mints do not require item rows", () => {
  const f = fixture();
  let rows = [],
    cursor;
  do {
    const p = f.page({ collection: "two", cursor });
    rows.push(...p.assets);
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(rows.length).toBe(66);
  expect(rows.every((r) => r.slug === "two")).toBeTrue();
  expect(rows.some((r) => r.name === "NFT #132")).toBeTrue();
  f.db.close();
});
test("reject invalid page inputs; no unbounded query or private creator fields", () => {
  const f = fixture();
  for (const q of [
    { limit: "0" },
    { limit: "65" },
    { limit: "1.5" },
    { limit: "NaN" },
    { cursor: "' OR 1=1" },
    { collection: "../secret" },
  ])
    expect(() => f.page(q)).toThrow();
  expect(Object.keys(f.page({ limit: "1" }).assets[0]!)).not.toContain(
    "shuffle_seed",
  );
  f.db.close();
});
test("exact NFT lookup is collection-bound and cannot combine an asset with a cursor", () => {
  const f = fixture(),
    asset = f.page({}).assets[0].asset as string;
  const page = f.page({ asset, collection: "one" });
  expect(page.assets.length).toBe(1);
  expect(page.assets[0].asset).toBe(asset);
  expect(page.nextCursor).toBeNull();
  expect(f.page({ asset, collection: "two" }).assets).toEqual([]);
  expect(() => f.page({ asset, cursor: asset })).toThrow();
});
