/// @ts-ignore: dependency is provided at the workspace root
import { Server, Asset, Operation } from "stellar-sdk";
import * as StellarSdk from "@stellar/stellar-sdk";
import { parseScaledAmount } from "./fixedAmount";

export interface TrustlineCheckResult {
  exists: boolean;
  authorized: boolean;
  details?: Record<string, unknown>;
}

export interface TrustlinePreview {
  operations: Operation[];
  transactionXdr: string;
}

export interface TrustlineValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface TrustlineResourceEstimate {
  baseFee: number;
  totalCost: string;
  trustlinesCreated: number;
  trustlinesRemoved: number;
  reservesRequired: string;
}

export interface TrustlineInfo {
  assetCode: string;
  assetIssuer: string;
  balance: string;
}

export interface AssetToTrust {
  assetCode: string;
  assetIssuer: string;
  limit?: string;
}

export interface TrustlineWorkflowConfig {
  horizonUrl?: string;
  networkPassphrase?: string;
  sourceSecret?: string;
  source?: string;
}

export enum TrustlineWorkflowStep {
  IDLE = "idle",
  PREVIEWING = "previewing",
  VALIDATING = "validating",
  ESTIMATING = "estimating",
  BUILDING = "building",
  READY = "ready",
}

export interface TrustlineWorkflowPreview {
  assetsToTrust: AssetToTrust[];
  existingTrustlines: TrustlineInfo[];
  operations: Operation[];
  transactionXdr: string;
  sourceAccount?: string;
  trustlinesToRemove?: TrustlineInfo[];
}

export interface TrustlineWorkflowValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  accountExists: boolean;
  missingTrustlines: AssetToTrust[];
  existingTrustlines: TrustlineInfo[];
}

export interface TrustlineWorkflowResourceEstimate {
  baseFee: number;
  totalCost: string;
  trustlinesCreated: number;
  trustlinesRemoved: number;
  reservesRequired: string;
  operationCount: number;
}

export interface TrustlineWorkflowResult {
  transactionXdr: string;
  signedTransactionXdr?: string;
  operations: Operation[];
  resourceEstimate: TrustlineWorkflowResourceEstimate;
}

export async function resolveIssuerFromDomain(
  domain: string,
  assetCode: string,
  timeout?: number
): Promise<string | undefined> {
  try {
    const url = `https://${domain}/.well-known/stellar.toml`;
    const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
    const response = await fetch(url, { signal });
    if (!response.ok) return undefined;

    const text = await response.text();
    const currenciesMatch = text.match(/\[\[CURRENCIES\]\]([\s\S]*?)(?=\[\[|$)/g);
    if (!currenciesMatch) return undefined;

    for (const currencyBlock of currenciesMatch) {
      const codeMatch = currencyBlock.match(/code\s*=\s*["'](.+?)["']/);
      const issuerMatch = currencyBlock.match(/issuer\s*=\s*["'](.+?)["']/);

      if (
        codeMatch &&
        codeMatch[1].toUpperCase() === assetCode.toUpperCase() &&
        issuerMatch
      ) {
        return issuerMatch[1];
      }
    }
    return undefined;
  } catch (error) {
    console.error(`Error resolving issuer from domain ${domain}:`, error);
    return undefined;
  }
}

export async function hasValidStellarTrustline(
  horizonUrl: string | undefined,
  accountId: string,
  assetCode: string,
  assetIssuer?: string
): Promise<TrustlineCheckResult> {
  const server = new Server(horizonUrl || "https://horizon.stellar.org");

  if (!assetCode || assetCode.toUpperCase() === "XLM") {
    return { exists: true, authorized: true };
  }

  let account: Record<string, unknown>;
  try {
    account = await server.accounts().accountId(accountId).call();
  } catch (err) {
    return {
      exists: false,
      authorized: false,
      details: { error: String(err) },
    };
  }

  const balances: Record<string, unknown>[] = (account.balances as Record<string, unknown>[]) || [];
  const match = balances.find((b) => {
    return (
      b['asset_code'] === assetCode &&
      (assetIssuer ? b['asset_issuer'] === assetIssuer : true)
    );
  });

  if (!match) {
    return { exists: false, authorized: false };
  }

  const authorized =
    (match.is_authorized as boolean) ??
    (match.authorized as boolean) ??
    (match.authorized_to_maintain_liabilities as boolean) ??
    true;

  return { exists: true, authorized, details: { balance: match } };
}

export async function findZeroBalanceTrustlines(
  horizonUrl: string | undefined,
  accountId: string
): Promise<TrustlineInfo[]> {
  const server = new Server(horizonUrl || "https://horizon.stellar.org");
  const account = await server.accounts().accountId(accountId).call();
  const balances: Record<string, unknown>[] = (account.balances as Record<string, unknown>[]) || [];

  return balances
    .filter((b) => b['asset_type'] !== "native" && parseScaledAmount(b['balance'] as string, 7) === 0n)
    .map((b) => ({
      assetCode: b['asset_code'] as string,
      assetIssuer: b['asset_issuer'] as string,
      balance: b['balance'] as string,
    }));
}

export function buildTrustlineRemovalOps(
  trustlines: TrustlineInfo[]
): Operation[] {
  return trustlines.map((t) =>
    Operation.changeTrust({
      asset: new Asset(t.assetCode, t.assetIssuer),
      limit: "0",
    })
  );
}

export async function createTrustlineOperation(
  assetCode: string,
  assetIssuer: string,
  limit?: string,
  timeout?: number
): Promise<Operation> {
  let issuer = assetIssuer;

  if (assetIssuer.includes(".") && !assetIssuer.startsWith("G")) {
    const resolvedIssuer = await resolveIssuerFromDomain(
      assetIssuer,
      assetCode,
      timeout
    );
    if (!resolvedIssuer) {
      throw new Error(
        `Could not resolve issuer for ${assetCode} from domain ${assetIssuer}`
      );
    }
    issuer = resolvedIssuer;
  }

  const asset = new Asset(assetCode, issuer);
  return Operation.changeTrust({
    asset,
    limit,
  });
}

export class TrustlineWorkflowBuilder {
  private assets: AssetToTrust[] = [];
  private trustlinesToRemove: TrustlineInfo[] = [];
  private config: Required<TrustlineWorkflowConfig>;
  private step: TrustlineWorkflowStep = TrustlineWorkflowStep.IDLE;

  constructor(config: TrustlineWorkflowConfig = {}) {
    this.config = {
      horizonUrl: config.horizonUrl || "https://horizon.stellar.org",
      networkPassphrase: config.networkPassphrase || StellarSdk.Networks.PUBLIC,
      sourceSecret: config.sourceSecret,
      source: config.source,
    };
  }

  addTrustline(assetCode: string, assetIssuer: string, limit?: string): this {
    this.assets.push({ assetCode, assetIssuer, limit });
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  addTrustlines(assets: AssetToTrust[]): this {
    this.assets.push(...assets);
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  addTrustlineRemoval(assetCode: string, assetIssuer: string): this {
    this.trustlinesToRemove.push({ assetCode, assetIssuer, balance: "0" });
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  async preview(): Promise<TrustlineWorkflowPreview> {
    this.step = TrustlineWorkflowStep.PREVIEWING;

    const server = new Server(this.config.horizonUrl);
    const existingTrustlines: TrustlineInfo[] = [];
    let sourceAccount: string | undefined;

    if (this.config.source) {
      try {
        const account = await server.accounts().accountId(this.config.source).call();
        const trustlines = (account.balances as Record<string, unknown>[])
          .filter((b) => b['asset_type'] !== "native")
          .map((b) => ({
            assetCode: b['asset_code'] as string,
            assetIssuer: b['asset_issuer'] as string,
            balance: b['balance'] as string,
          }));
        existingTrustlines.push(...trustlines);
        sourceAccount = this.config.source;
      } catch {
        // Account may not exist
      }
    }

    const resolvedAssets = await Promise.all(
      this.assets.map(async (a) => {
        if (a.assetIssuer.includes(".") && !a.assetIssuer.startsWith("G")) {
          const issuer = await resolveIssuerFromDomain(a.assetIssuer, a.assetCode);
          return issuer ? { ...a, assetIssuer: issuer } : a;
        }
        return a;
      })
    );

    const operations: Operation[] = [
      ...resolvedAssets.map((a) =>
        Operation.changeTrust({
          asset: new Asset(a.assetCode, a.assetIssuer),
          limit: a.limit,
        })
      ),
      ...this.trustlinesToRemove.map((t) =>
        Operation.changeTrust({
          asset: new Asset(t.assetCode, t.assetIssuer),
          limit: "0",
        })
      ),
    ];

    let transactionXdr = "";
    if (sourceAccount) {
      const tx = new StellarSdk.TransactionBuilder(
        new StellarSdk.Account(sourceAccount, "0"),
        {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        }
      );
      operations.forEach((op) => tx.addOperation(op));
      transactionXdr = tx.build().toXDR();
    }

    return {
      assetsToTrust: resolvedAssets,
      existingTrustlines,
      trustlinesToRemove: this.trustlinesToRemove,
      operations,
      transactionXdr,
      sourceAccount,
    };
  }

  async validate(): Promise<TrustlineWorkflowValidation> {
    this.step = TrustlineWorkflowStep.VALIDATING;

    const errors: string[] = [];
    const warnings: string[] = [];
    let accountExists = false;
    const existingTrustlines: TrustlineInfo[] = [];
    const server = new Server(this.config.horizonUrl);

    if (this.config.source) {
      try {
        const account = await server.accounts().accountId(this.config.source).call();
        const trustlines = (account.balances as Record<string, unknown>[])
          .filter((b) => b['asset_type'] !== "native")
          .map((b) => ({
            assetCode: b['asset_code'] as string,
            assetIssuer: b['asset_issuer'] as string,
            balance: b['balance'] as string,
          }));
        existingTrustlines.push(...trustlines);
        accountExists = true;
      } catch {
        errors.push(`Source account ${this.config.source} not found`);
      }
    } else {
      errors.push("Source account is required for validation");
    }

    const resolvedAssets = await Promise.all(
      this.assets.map(async (a) => {
        if (a.assetIssuer.includes(".") && !a.assetIssuer.startsWith("G")) {
          const issuer = await resolveIssuerFromDomain(a.assetIssuer, a.assetCode);
          return issuer ? { ...a, assetIssuer: issuer } : a;
        }
        return a;
      })
    );

    resolvedAssets.forEach((a) => {
      const hasExisting = existingTrustlines.some(
        (t) => t.assetCode === a.assetCode && t.assetIssuer === a.assetIssuer
      );
      if (hasExisting) {
        warnings.push(
          `Trustline for ${a.assetCode} already exists on account`
        );
      }
    });

    const missingTrustlines = resolvedAssets.filter((a) => {
      return !existingTrustlines.some(
        (t) => t.assetCode === a.assetCode && t.assetIssuer === a.assetIssuer
      );
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      accountExists,
      missingTrustlines,
      existingTrustlines,
    };
  }

  estimate(previewResult?: TrustlineWorkflowPreview): TrustlineWorkflowResourceEstimate {
    this.step = TrustlineWorkflowStep.ESTIMATING;

    const preview = previewResult || { assetsToTrust: [], trustlinesToRemove: [] };
    const operationCount = preview.assetsToTrust.length + preview.trustlinesToRemove.length;
    const trustlinesCreated = preview.assetsToTrust.length;
    const trustlinesRemoved = preview.trustlinesToRemove.length;
    const reservesRequired = trustlinesCreated.toString();

    return {
      baseFee: 100,
      totalCost: operationCount.toString(),
      trustlinesCreated,
      trustlinesRemoved,
      reservesRequired,
      operationCount,
    };
  }

  async build(): Promise<TrustlineWorkflowResult> {
    const preview = await this.preview();
    const estimate = this.estimate(preview);

    return {
      transactionXdr: preview.transactionXdr,
      operations: preview.operations,
      resourceEstimate: estimate,
    };
  }

  getCurrentStep(): TrustlineWorkflowStep {
    return this.step;
  }
}

export default hasValidStellarTrustline;