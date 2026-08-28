import {
  parseScaledAmount,
  serializeScaledAmount,
} from "./fixedAmount";

/**
 * Stellar Claimable Balance Utilities
 *
 * Provides functionality to search for and claim pending claimable balances
 * for a given Stellar account.
 */

export interface ClaimableBalance {
  /** Unique identifier for the claimable balance */
  id: string;
  /** Asset code (e.g., "XLM", "USDC") */
  asset: string;
  /** Amount available to claim */
  amount: string;
  /** Account that created the claimable balance */
  sponsor: string;
  /** Timestamp when the balance was created */
  createdAt?: string;
  /** Claimants who can claim this balance */
  claimants: Array<{
    destination: string;
    predicate: unknown;
  }>;
}

export interface ClaimableBalanceSearchOptions {
  /** Stellar account public key to search for */
  accountId: string;
  /** Network to use: "testnet" or "mainnet" */
  network?: "testnet" | "mainnet";
  /** Optional custom Horizon URL */
  horizonUrl?: string;
  /** Limit number of results (default: 200) */
  limit?: number;
}

export interface ClaimBalanceOptions {
  /** Claimable balance ID to claim */
  balanceId: string;
  /** Secret key of the claimant account */
  claimantSecret: string;
  /** Network to use: "testnet" or "mainnet" */
  network?: "testnet" | "mainnet";
  /** Optional custom Horizon URL */
  horizonUrl?: string;
}

export interface ClaimBalanceResult {
  /** Whether the claim was successful */
  success: boolean;
  /** Transaction hash if successful */
  transactionHash?: string;
  /** Error message if failed */
  error?: string;
  /** Claimed balance details */
  balance?: ClaimableBalance;
}

/**
 * Search for claimable balances for a given account
 */
export async function searchClaimableBalances(
  options: ClaimableBalanceSearchOptions
): Promise<ClaimableBalance[]> {
  const StellarSdk = await import("stellar-sdk");

  const horizonUrl =
    options.horizonUrl ||
    (options.network === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  const server = new StellarSdk.Horizon.Server(horizonUrl);

  try {
    const balancesCall = server
      .claimableBalances()
      .claimant(options.accountId)
      .limit(options.limit || 200);

    const response = await balancesCall.call();

    return response.records.map((record: unknown) => {
      const rec = record as Record<string, unknown>;
      return {
        id: rec.id as string,
        asset:
          rec.asset === "native" ? "XLM" : `${String(rec.asset).split(":")[0]}`,
        amount: rec.amount as string,
        sponsor: (rec.sponsor as string) || "",
        createdAt: rec.last_modified_time as string,
        claimants: (rec.claimants as Array<Record<string, unknown>>).map(
          (c) => ({
            destination: c.destination as string,
            predicate: c.predicate,
          })
        ),
      };
    });
  } catch (error) {
    throw new Error(
      `Failed to search claimable balances: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Claim a specific claimable balance
 */
export async function claimBalance(
  options: ClaimBalanceOptions
): Promise<ClaimBalanceResult> {
  const StellarSdk = await import("stellar-sdk");

  const horizonUrl =
    options.horizonUrl ||
    (options.network === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  const networkPassphrase =
    options.network === "mainnet"
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;

  const server = new StellarSdk.Horizon.Server(horizonUrl);

  try {
    // Load the claimant keypair
    const claimantKeypair = StellarSdk.Keypair.fromSecret(
      options.claimantSecret
    );
    const claimantPublicKey = claimantKeypair.publicKey();

    // Fetch balance details first
    const balanceRecord = await server
      .claimableBalances()
      .claimableBalance(options.balanceId)
      .call();

    const balance: ClaimableBalance = {
      id: balanceRecord.id,
      asset:
        balanceRecord.asset === "native"
          ? "XLM"
          : `${balanceRecord.asset.split(":")[0]}`,
      amount: balanceRecord.amount,
      sponsor: balanceRecord.sponsor || "",
      createdAt: (balanceRecord as unknown as Record<string, unknown>)
        .last_modified_time as string,
      claimants: balanceRecord.claimants.map((c: unknown) => {
        const claimant = c as Record<string, unknown>;
        return {
          destination: claimant.destination as string,
          predicate: claimant.predicate,
        };
      }),
    };

    // Verify the account is a valid claimant
    const isClaimant = balance.claimants.some(
      (c) => c.destination === claimantPublicKey
    );

    if (!isClaimant) {
      return {
        success: false,
        error: `Account ${claimantPublicKey} is not a valid claimant for this balance`,
        balance,
      };
    }

    // Load the claimant account
    const account = await server.loadAccount(claimantPublicKey);

    // Build the claim transaction
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.claimClaimableBalance({
          balanceId: options.balanceId,
        })
      )
      .setTimeout(180)
      .build();

    // Sign the transaction
    transaction.sign(claimantKeypair);

    // Submit the transaction
    const result = await server.submitTransaction(transaction);

    return {
      success: true,
      transactionHash: result.hash,
      balance,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get total claimable amount for an account grouped by asset
 */
export async function getTotalClaimableAmount(
  options: ClaimableBalanceSearchOptions
): Promise<Record<string, string>> {
  const balances = await searchClaimableBalances(options);

  // #622: aggregate with fixed-precision (BigInt) arithmetic at Stellar's
  // default 7 decimals — never float `number`.
  const totals: Record<string, bigint> = {};

  for (const balance of balances) {
    totals[balance.asset] =
      (totals[balance.asset] ?? 0n) + parseScaledAmount(balance.amount, 7);
  }

  const result: Record<string, string> = {};
  for (const [asset, units] of Object.entries(totals)) {
    result[asset] = serializeScaledAmount(units, 7);
  }

  return result;
}
