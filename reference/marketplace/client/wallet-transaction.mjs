import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const genesis = {
  "solana:mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "solana:devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export async function assertConnectionChain(connection, chain, localGenesis) {
  const expected =
    genesis[chain] ?? (chain === "solana:localnet" ? localGenesis : null);
  if (!expected || (await connection.getGenesisHash()) !== expected)
    throw Error("RPC chain mismatch");
  return expected;
}

// Wallet Standard receives an explicit chain. Legacy injected signTransaction
// cannot reliably identify Devnet, which caused the misleading Phantom prompt.
export async function sendWalletTransaction({
  connection,
  wallet,
  account: selected,
  chain,
  transaction,
  localGenesis,
  beforeSubmit,
}) {
  const selectedAddress = selected.address;
  await assertConnectionChain(connection, chain, localGenesis);
  const feature = wallet.features["solana:signTransaction"];
  if (
    !wallet.chains.includes(chain) ||
    !selected.chains.includes(chain) ||
    !selected.features.includes("solana:signTransaction") ||
    !feature?.supportedTransactionVersions.includes("legacy")
  )
    throw Error("Wallet does not support this chain and transaction");
  const current = () =>
    selected.address === selectedAddress &&
    wallet.accounts.find(
      (a) =>
        a.address === selectedAddress &&
        a.chains.includes(chain) &&
        a.features.includes("solana:signTransaction"),
    );
  if (!current()) throw Error("Wallet account changed");
  if (
    !transaction ||
    !Array.isArray(transaction.instructions) ||
    !transaction.instructions.length ||
    typeof transaction.serializeMessage !== "function"
  )
    throw Error("A nonempty legacy transaction is required");
  const owner = new PublicKey(selected.address);
  if (!owner.equals(new PublicKey(selected.publicKey)))
    throw Error("Wallet address and key differ");
  const validity = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = owner;
  transaction.recentBlockhash = validity.blockhash;
  const message = transaction.serializeMessage();
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const [output] = await feature.signTransaction({
    account: selected,
    chain,
    transaction: new Uint8Array(serialized),
  });
  if (!current()) throw Error("Wallet account changed");
  if (!output?.signedTransaction)
    throw Error("Wallet returned no signed transaction");
  const signed = Transaction.from(output.signedTransaction);
  if (!signed.serializeMessage().equals(message))
    throw Error("Wallet changed the transaction message");
  if (!current()) throw Error("Wallet account changed");
  if (!signed.verifySignatures())
    throw Error("Transaction signatures are invalid or incomplete");
  const expectedSignature = signed.signature;
  if (
    !expectedSignature ||
    !nacl.sign.detached.verify(message, expectedSignature, owner.toBytes())
  )
    throw Error("Wallet signature is invalid");
  // Preserve the exact signed legacy message during simulation. The legacy
  // web3 overload refreshes its blockhash and depends on constructor identity.
  const simulated = await connection.simulateTransaction(
    VersionedTransaction.deserialize(signed.serialize()),
    { sigVerify: true, commitment: "confirmed" },
  );
  if (simulated.value.err)
    throw Error(
      "Transaction simulation rejected: " + JSON.stringify(simulated.value.err),
    );
  if (beforeSubmit)
    await beforeSubmit({
      signature: bs58.encode(expectedSignature),
      ...validity,
    });
  if (!current()) throw Error("Wallet account changed");
  let signature;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (cause) {
    throw Object.assign(
      Error(
        "Submission unresolved; check the signed transaction before retrying",
      ),
      { signature: bs58.encode(expectedSignature), cause },
    );
  }
  if (signature !== bs58.encode(expectedSignature))
    throw Object.assign(
      Error(
        "RPC returned a different signature; inspect the signed transaction before retrying",
      ),
      { signature: bs58.encode(expectedSignature) },
    );
  let result;
  try {
    result = await connection.confirmTransaction(
      { ...validity, signature },
      "confirmed",
    );
  } catch (error) {
    // Never silently re-sign or replay after ambiguous confirmation.
    const status = (
      await connection
        .getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
        .catch((cause) => {
          throw Object.assign(
            Error(
              "Confirmation lookup failed; check this signature before retrying",
            ),
            { signature, cause },
          );
        })
    ).value[0];
    if (status?.err)
      throw Error("Transaction failed: " + JSON.stringify(status.err));
    if (
      !status ||
      !["confirmed", "finalized"].includes(status.confirmationStatus)
    )
      throw Object.assign(
        Error(
          "Confirmation unresolved; check this signature before retrying: " +
            signature,
        ),
        { signature, cause: error },
      );
  }
  if (result?.value.err)
    throw Error("Transaction failed: " + JSON.stringify(result.value.err));
  return signature;
}
