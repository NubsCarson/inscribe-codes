// Keep this in sync with the NFT registry program's PLATFORM_FEE_BPS.
export const PLATFORM_FEE_BPS = 500;

// Match the registry's division in whole base units.
export const mintPlatformFee = (price) => BigInt(price) * BigInt(PLATFORM_FEE_BPS) / 10_000n;
