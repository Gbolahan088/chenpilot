#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, contractclient, symbol_short,
    Address, Bytes, BytesN, Env, Vec,
};
use contract_failure::{fail, FailureReason};
use pause_state;

/// Reorg / stale-proof / header-chain errors introduced by this change.
/// A separate small enum rather than new `contract_failure::FailureReason`
/// variants — see the `DEFAULT_MAX_SAFE_REORG_DEPTH` doc comment above and
/// this PR's caveats: `FailureReason` is already over Soroban's 50-variant
/// `#[contracterror]` cap and does not compile as committed, independent of
/// this change.
#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum RelayError {
    /// `submit_header`'s `prev_block_hash` doesn't match any header this
    /// contract has already recorded, and isn't the configured genesis
    /// checkpoint either — we have no way to place it in a chain.
    UnknownParentHeader = 1,
    /// A competing chain was submitted whose fork point is deeper than
    /// `max_safe_reorg_depth` behind the current checkpoint. Rejected
    /// rather than silently applied — see `submit_header`.
    ReorgBeyondSafetyDepth = 2,
    /// `verify_and_claim`'s proof references a block that IS tracked (via
    /// `submit_header`) but is no longer on the canonical chain — it was
    /// orphaned by an accepted reorg. See `is_block_orphaned`.
    ProofReferencesOrphanedBlock = 3,
    /// `verify_and_claim`'s proof references a tracked block whose height
    /// is more than `max_stale_depth` behind the current checkpoint tip
    /// without ever having reached `min_confirmations` — i.e. it sat
    /// unclaimed long enough that it should be re-verified against the
    /// current chain state rather than trusted as-is.
    StaleProof = 4,
    /// The submitted header's own claimed height doesn't match
    /// parent_height + 1.
    InvalidHeaderHeight = 5,
}

const CLAIMED_TX_TTL_LEDGERS: u32 = 6_048_000;
const MAX_MERKLE_PROOF_DEPTH: u32 = 32;

#[contractclient(name = "BtcCryptoClient")]
pub trait BtcCryptoTrait {
    fn double_sha256(env: Env, data: Bytes) -> BytesN<32>;
    fn extract_merkle_root(env: Env, header: Bytes) -> BytesN<32>;
    fn extract_target(env: Env, header: Bytes) -> BytesN<32>;
    fn extract_prev_block_hash(env: Env, header: Bytes) -> BytesN<32>;
    fn hash_meets_target(env: Env, hash: BytesN<32>, target: BytesN<32>) -> bool;
    fn compute_merkle_root(
        env: Env,
        tx_id: BytesN<32>,
        proof: Vec<BytesN<32>>,
        tx_index: u32,
    ) -> BytesN<32>;
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Claimed(BytesN<32>),
    /// A submitted header, by its own block hash. See `HeaderRecord`.
    Header(BytesN<32>),
    /// The current canonical-chain checkpoint. See `Checkpoint`.
    Checkpoint,
    /// Optional per-contract override of `DEFAULT_MAX_SAFE_REORG_DEPTH`.
    MaxSafeReorgDepth,
    /// Optional per-contract override of `DEFAULT_MAX_STALE_DEPTH`.
    MaxStaleDepth,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub wrapped_btc_token: Address,
    pub min_confirmations: u32,
    pub crypto_contract: Address,
}

// ---------------------------------------------------------------------------
// Header chain / checkpoint (reorg and stale-proof recovery semantics)
// ---------------------------------------------------------------------------
//
// See BTC_RELAY_FINALITY.md for the full policy. Summary: before this
// change, the relay tracked no chain state at all — `min_confirmations`
// was a Merkle-proof-depth check, not a real confirmation-depth guarantee,
// and a reorg was undetectable by the contract. This adds an explicit,
// height-based checkpoint that `submit_header` maintains and
// `verify_and_claim` consults when a proof's block has one.

/// One submitted header's tracked state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeaderRecord {
    pub block_hash: BytesN<32>,
    pub prev_block_hash: BytesN<32>,
    /// Height this header was submitted at (height 0 is the configured
    /// genesis checkpoint set at `initialize`/`set_genesis_checkpoint`).
    pub height: u32,
    /// Bitcoin header timestamp field (seconds since epoch, as encoded in
    /// the header itself — not the Stellar ledger timestamp).
    pub header_timestamp: u64,
    /// False once a deeper competing chain has orphaned this header (see
    /// `submit_header`'s reorg handling). Orphaned headers are kept (not
    /// deleted) for audit purposes — same rationale as claimed-tx records.
    pub on_canonical_chain: bool,
}

/// The current canonical-chain tip, as tracked by `submit_header`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub block_hash: BytesN<32>,
    pub height: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct EvtHeaderAccepted {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub block_hash: BytesN<32>,
    pub height: u32,
}

/// Emitted when `submit_header` detects and applies a reorg — i.e. a
/// competing chain whose tip height exceeds the previous checkpoint's
/// height, within `max_safe_reorg_depth`. `orphaned_from_height` is the
/// height of the shallowest header now marked `on_canonical_chain = false`.
#[contracttype]
#[derive(Clone)]
pub struct EvtReorgApplied {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub old_tip_hash: BytesN<32>,
    pub old_tip_height: u32,
    pub new_tip_hash: BytesN<32>,
    pub new_tip_height: u32,
    pub orphaned_from_height: u32,
}

/// Published (before panicking) when `submit_header` rejects a competing
/// chain because applying it would mean reorganizing deeper than
/// `max_safe_reorg_depth`. NOTE: because the call panics right after with
/// `RelayError::ReorgBeyondSafetyDepth`, and Soroban invocations are
/// atomic, this event never actually persists — see the "atomic" note on
/// `submit_header`. Kept for code clarity / as documentation of intent,
/// not as something a caller can observe.
#[contracttype]
#[derive(Clone)]
pub struct EvtReorgRejected {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub current_tip_hash: BytesN<32>,
    pub current_tip_height: u32,
    pub rejected_hash: BytesN<32>,
    pub rejected_height: u32,
    pub fork_depth: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct EvtInit {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub admin: Address,
    pub wrapped_btc_token: Address,
    pub min_confirmations: u32,
    pub crypto_contract: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct EvtCfgUpd {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub admin: Address,
    pub wrapped_btc_token: Address,
    pub min_confirmations: u32,
    pub crypto_contract: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct EvtRelayOk {
    pub version: u32,
    pub ledger: u32,
    pub actor: Address,
    pub tx_id: BytesN<32>,
    pub recipient: Address,
    pub amount_sat: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpvProof {
    pub block_header: Bytes,
    pub tx_id: BytesN<32>,
    pub merkle_proof: Vec<BytesN<32>>,
    pub tx_index: u32,
    pub amount_sat: i128,
    pub recipient: Address,
}

#[contract]
pub struct BtcRelayContract;

fn validate_config(config: &Config) {
    if config.min_confirmations == 0 || config.min_confirmations > MAX_MERKLE_PROOF_DEPTH {
        panic!("invalid confirmation requirement");
    }
}

#[contractimpl]
impl BtcRelayContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        wrapped_btc_token: Address,
        min_confirmations: u32,
        crypto_contract: Address,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            fail(&env, FailureReason::AlreadyInitialized);
        }

        let config = Config {
            admin: admin.clone(),
            wrapped_btc_token: wrapped_btc_token.clone(),
            min_confirmations,
            crypto_contract: crypto_contract.clone(),
        };
        validate_config(&config);
        env.storage().instance().set(&DataKey::Config, &config);

        env.events().publish(
            (symbol_short!("btc"), symbol_short!("init")),
            EvtInit {
                version: 1,
                ledger: env.ledger().sequence(),
                actor: admin.clone(),
                admin,
                wrapped_btc_token,
                min_confirmations,
                crypto_contract,
            },
        );
    }

    pub fn update_config(env: Env, config: Config) {
        let current: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        current.admin.require_auth();
        validate_config(&config);

        env.storage().instance().set(&DataKey::Config, &config);
        env.events().publish(
            (symbol_short!("btc"), symbol_short!("cfg_upd")),
            EvtCfgUpd {
                version: 1,
                ledger: env.ledger().sequence(),
                actor: current.admin,
                admin: config.admin.clone(),
                wrapped_btc_token: config.wrapped_btc_token.clone(),
                min_confirmations: config.min_confirmations,
                crypto_contract: config.crypto_contract.clone(),
            },
        );
    }

    pub fn verify_and_claim(env: Env, proof: SpvProof) -> (Address, i128) {
    // ── Emergency pause (see the `pause_state` crate for the standard) ─────────
    //
    // Pausing blocks verify_and_claim() — no new BTC-relay claims are
    // accepted during an incident (e.g. a suspected deep reorg or a
    // relayer compromise). It does not touch already-claimed records;
    // see BTC_RELAY_FINALITY.md for what does and doesn't happen to
    // existing claims.

    /// Pause the relay. Blocks `verify_and_claim()` until `unpause()`.
    /// Trust boundary: Config.admin only.
    pub fn pause(env: Env) {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        config.admin.require_auth();
        pause_state::pause(&env, config.admin);
    }

    /// Unpause the relay, re-enabling `verify_and_claim()`.
    /// Trust boundary: Config.admin only.
    pub fn unpause(env: Env) {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        config.admin.require_auth();
        pause_state::unpause(&env, config.admin);
    }

    /// Whether the relay is currently paused. Safe to call from another
    /// contract via a `#[contractclient]` trait for cross-contract pause
    /// checks — see `pause_state`'s module doc. A downstream consumer of
    /// BTC-relay claims (e.g. a swap contract) can check this before
    /// trusting a claim made during a since-detected incident window.
    pub fn is_paused(env: Env) -> bool {
        pause_state::is_paused(&env)
    }

    // ── Header chain / checkpoint (reorg and stale-proof recovery) ─────────────
    //
    // See BTC_RELAY_FINALITY.md and the module doc above HeaderRecord for the
    // full policy. This is opt-in and additive: verify_and_claim's existing
    // Merkle-proof-depth check still runs unconditionally (so callers who
    // never call submit_header keep today's exact behaviour), but IF the
    // proof's block has been submitted via submit_header, verify_and_claim
    // additionally enforces real height-based confirmation depth and
    // rejects proofs for orphaned or stale blocks.

    /// Set the genesis checkpoint — the header chain's starting point.
    /// Must be called once before the first `submit_header`. Admin only,
    /// since this establishes the trust root the rest of the chain builds
    /// on (equivalent to a light client's hardcoded checkpoint).
    pub fn set_genesis_checkpoint(
        env: Env,
        block_hash: BytesN<32>,
        height: u32,
        header_timestamp: u64,
    ) {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        config.admin.require_auth();

        if env.storage().instance().has(&DataKey::Checkpoint) {
            fail(&env, FailureReason::AlreadyInitialized);
        }

        let record = HeaderRecord {
            block_hash: block_hash.clone(),
            // Genesis has no tracked parent — using the block's own hash
            // as a sentinel keeps the field non-optional and self-evident
            // (a real parent lookup would never match a header to itself).
            prev_block_hash: block_hash.clone(),
            height,
            header_timestamp,
            on_canonical_chain: true,
        };
        persist_with_ttl(&env, &DataKey::Header(block_hash.clone()), &record, HEADER_TTL_LEDGERS);
        env.storage()
            .instance()
            .set(&DataKey::Checkpoint, &Checkpoint { block_hash, height });
    }

    /// Configure the safety window used by `submit_header`'s reorg
    /// handling. Admin only. Defaults to `DEFAULT_MAX_SAFE_REORG_DEPTH`
    /// when never called.
    pub fn set_max_safe_reorg_depth(env: Env, depth: u32) {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        config.admin.require_auth();
        env.storage().instance().set(&DataKey::MaxSafeReorgDepth, &depth);
    }

    /// Configure the staleness window used by `verify_and_claim`. Admin
    /// only. Defaults to `DEFAULT_MAX_STALE_DEPTH` when never called.
    pub fn set_max_stale_depth(env: Env, depth: u32) {
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        config.admin.require_auth();
        env.storage().instance().set(&DataKey::MaxStaleDepth, &depth);
    }

    fn max_safe_reorg_depth(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxSafeReorgDepth)
            .unwrap_or(DEFAULT_MAX_SAFE_REORG_DEPTH)
    }

    fn max_stale_depth(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxStaleDepth)
            .unwrap_or(DEFAULT_MAX_STALE_DEPTH)
    }

    /// Submit a new header, extending the tracked chain from its parent.
    ///
    /// Permissionless by design (like real Bitcoin relayers/light clients —
    /// anyone can forward a valid header; validity is enforced by PoW +
    /// parent linkage, not by caller identity). Blocked while paused (see
    /// `pause()`), same reasoning as `verify_and_claim`.
    ///
    /// Behaviour:
    ///   - `height` must be `parent.height + 1` (`InvalidHeaderHeight`).
    ///   - The parent (by `prev_block_hash`) must already be tracked
    ///     (`UnknownParentHeader`) — chains must be submitted in order,
    ///     starting from the genesis checkpoint.
    ///   - PoW must be valid, same check as `verify_and_claim`.
    ///   - If this header's height is greater than the current checkpoint's
    ///     height, it becomes the new tip. If its parent chain diverges
    ///     from the currently-canonical chain (a reorg), every currently-
    ///     canonical header from the fork point onward is marked
    ///     `on_canonical_chain = false`, every one of the new chain's own
    ///     ancestors back to the fork point is marked
    ///     `on_canonical_chain = true`, and an `EvtReorgApplied` event is
    ///     emitted — UNLESS the fork point is deeper than
    ///     `max_safe_reorg_depth` behind the current tip, in which case the
    ///     call panics with `RelayError::ReorgBeyondSafetyDepth` and NOTHING
    ///     persists: Soroban invocations are atomic, and a panic discards
    ///     both storage writes and published events from that invocation
    ///     (verified directly against this SDK version — a call that
    ///     publishes an event and then panics leaves `env.events().all()`
    ///     empty for that invocation). `EvtReorgRejected` is emitted before
    ///     the panic anyway to keep the code's intent explicit, but a
    ///     caller/indexer will never actually observe it — the deep-reorg
    ///     attempt is only visible as the call reverting. Off-chain tooling
    ///     watching this relay should treat a `ReorgBeyondSafetyDepth`
    ///     failed-transaction result itself as the signal.
    ///   - If this header's height is not greater than the current tip's,
    ///     it's recorded as a (non-canonical) side branch with no further
    ///     action — this is the normal case for a header that's simply
    ///     behind, not a rejected reorg.
    pub fn submit_header(env: Env, header: Bytes, height: u32) -> BytesN<32> {
        pause_state::require_not_paused(&env);
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        let crypto = BtcCryptoClient::new(&env, &config.crypto_contract);

        if header.len() != 80 {
            fail(&env, FailureReason::InvalidBlockHeaderLength);
        }

        let block_hash = crypto.double_sha256(&header);
        let target = crypto.extract_target(&header);
        if !crypto.hash_meets_target(&block_hash, &target) {
            fail(&env, FailureReason::ProofOfWorkCheckFailed);
        }

        let prev_block_hash = crypto.extract_prev_block_hash(&header);
        let parent: HeaderRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Header(prev_block_hash.clone()))
            .unwrap_or_else(|| env.panic_with_error(RelayError::UnknownParentHeader));

        if height != parent.height + 1 {
            env.panic_with_error(RelayError::InvalidHeaderHeight);
        }

        let checkpoint: Checkpoint = env
            .storage()
            .instance()
            .get(&DataKey::Checkpoint)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));

        let becomes_new_tip = height > checkpoint.height;

        if becomes_new_tip {
            // Find the fork point and, if this is a reorg (not a simple
            // linear extension of the current tip), flip on_canonical_chain
            // in both directions: false for the displaced old-chain headers,
            // true for the new chain's own ancestors that were previously
            // recorded as non-canonical side branches (every header between
            // the fork point and `parent` must already be tracked, since
            // submit_header requires strictly sequential height submission).
            //
            // Walk the NEW chain's ancestors back to the OLD tip's height
            // first (new_cursor), then walk BOTH chains back together
            // (old_cursor from the old tip) until their hashes match — that
            // match is the fork point. Bounded to max_safe_reorg_depth + 1
            // steps total so a malicious deep chain can't force unbounded
            // work in a single call.
            let max_depth = Self::max_safe_reorg_depth(&env);
            let mut new_chain_ancestors: Vec<HeaderRecord> = Vec::new(&env);
            let mut new_cursor = parent.clone();
            let mut steps: u32 = 0;

            while new_cursor.height > checkpoint.height {
                new_chain_ancestors.push_back(new_cursor.clone());
                steps += 1;
                if steps > max_depth {
                    Self::reject_reorg(&env, &config, &checkpoint, &block_hash, height, steps);
                }
                new_cursor = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Header(new_cursor.prev_block_hash.clone()))
                    .unwrap_or_else(|| env.panic_with_error(RelayError::UnknownParentHeader));
            }
            // new_cursor is now at checkpoint.height, on the new chain's
            // ancestry. old_cursor starts at the actual old tip.
            let mut old_cursor: HeaderRecord = env
                .storage()
                .persistent()
                .get(&DataKey::Header(checkpoint.block_hash.clone()))
                .unwrap_or_else(|| fail(&env, FailureReason::NotFound));
            let mut to_orphan: Vec<BytesN<32>> = Vec::new(&env);

            while old_cursor.block_hash != new_cursor.block_hash {
                to_orphan.push_back(old_cursor.block_hash.clone());
                new_chain_ancestors.push_back(new_cursor.clone());
                steps += 1;
                if steps > max_depth {
                    Self::reject_reorg(&env, &config, &checkpoint, &block_hash, height, steps);
                }
                old_cursor = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Header(old_cursor.prev_block_hash.clone()))
                    .unwrap_or_else(|| env.panic_with_error(RelayError::UnknownParentHeader));
                new_cursor = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Header(new_cursor.prev_block_hash.clone()))
                    .unwrap_or_else(|| env.panic_with_error(RelayError::UnknownParentHeader));
            }

            let is_reorg = !to_orphan.is_empty();
            let orphaned_from_height = new_cursor.height + 1;

            // Displaced old-chain headers → orphaned.
            for h in to_orphan.iter() {
                Self::set_canonical(&env, &h, false);
            }
            // New chain's own previously-side-branch ancestors → canonical.
            for rec in new_chain_ancestors.iter() {
                Self::set_canonical(&env, &rec.block_hash, true);
            }

            let new_record = HeaderRecord {
                block_hash: block_hash.clone(),
                prev_block_hash,
                height,
                header_timestamp: header_timestamp(&header),
                on_canonical_chain: true,
            };
            persist_with_ttl(&env, &DataKey::Header(block_hash.clone()), &new_record, HEADER_TTL_LEDGERS);

            let old_tip_hash = checkpoint.block_hash.clone();
            let old_tip_height = checkpoint.height;
            env.storage().instance().set(
                &DataKey::Checkpoint,
                &Checkpoint { block_hash: block_hash.clone(), height },
            );

            if is_reorg {
                env.events().publish(
                    (symbol_short!("btc"), symbol_short!("reorg_ok")),
                    EvtReorgApplied {
                        version: 1,
                        ledger: env.ledger().sequence(),
                        actor: config.admin.clone(),
                        old_tip_hash,
                        old_tip_height,
                        new_tip_hash: block_hash.clone(),
                        new_tip_height: height,
                        orphaned_from_height,
                    },
                );
            } else {
                env.events().publish(
                    (symbol_short!("btc"), symbol_short!("hdr_ok")),
                    EvtHeaderAccepted {
                        version: 1,
                        ledger: env.ledger().sequence(),
                        actor: config.admin.clone(),
                        block_hash: block_hash.clone(),
                        height,
                    },
                );
            }
        } else {
            // Height doesn't exceed the current tip — record as a
            // non-canonical side branch. Not a rejection: this is the
            // ordinary "someone submitted a header we've already passed"
            // case, distinct from a rejected deep reorg.
            let record = HeaderRecord {
                block_hash: block_hash.clone(),
                prev_block_hash,
                height,
                header_timestamp: header_timestamp(&header),
                on_canonical_chain: false,
            };
            persist_with_ttl(&env, &DataKey::Header(block_hash.clone()), &record, HEADER_TTL_LEDGERS);
        }

        block_hash
    }

    /// Flip a tracked header's `on_canonical_chain` flag. No-op if the
    /// header isn't tracked (shouldn't happen for hashes collected while
    /// walking the chain in `submit_header`, but fails safe rather than
    /// panicking on a storage race).
    fn set_canonical(env: &Env, block_hash: &BytesN<32>, canonical: bool) {
        if let Some(mut rec) = env
            .storage()
            .persistent()
            .get::<DataKey, HeaderRecord>(&DataKey::Header(block_hash.clone()))
        {
            rec.on_canonical_chain = canonical;
            persist_with_ttl(env, &DataKey::Header(block_hash.clone()), &rec, HEADER_TTL_LEDGERS);
        }
    }

    /// Record a rejected-reorg header (as a non-canonical side branch, for
    /// audit) and emit `EvtReorgRejected`, then panic with
    /// `RelayError::ReorgBeyondSafetyDepth`. Shared by both loops in
    /// `submit_header` that can hit the safety-depth bound.
    fn reject_reorg(
        env: &Env,
        config: &Config,
        checkpoint: &Checkpoint,
        block_hash: &BytesN<32>,
        height: u32,
        fork_depth: u32,
    ) -> ! {
        env.events().publish(
            (symbol_short!("btc"), symbol_short!("reorg_rej")),
            EvtReorgRejected {
                version: 1,
                ledger: env.ledger().sequence(),
                actor: config.admin.clone(),
                current_tip_hash: checkpoint.block_hash.clone(),
                current_tip_height: checkpoint.height,
                rejected_hash: block_hash.clone(),
                rejected_height: height,
                fork_depth,
            },
        );
        env.panic_with_error(RelayError::ReorgBeyondSafetyDepth);
    }

    /// Current canonical-chain checkpoint, if `set_genesis_checkpoint` has
    /// been called. `None` means the header-chain feature hasn't been set
    /// up yet — `verify_and_claim` falls back to Merkle-proof-depth-only
    /// verification in that case (see `verify_and_claim`).
    pub fn get_checkpoint(env: Env) -> Option<Checkpoint> {
        env.storage().instance().get(&DataKey::Checkpoint)
    }

    /// Look up a tracked header by its block hash.
    pub fn get_header(env: Env, block_hash: BytesN<32>) -> Option<HeaderRecord> {
        env.storage().persistent().get(&DataKey::Header(block_hash))
    }

    /// Whether a tracked block has been orphaned by an accepted reorg.
    /// Returns `false` for a block that was never submitted via
    /// `submit_header` at all — callers that need to distinguish
    /// "never tracked" from "tracked and canonical" should use
    /// `get_header` directly.
    pub fn is_block_orphaned(env: Env, block_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, HeaderRecord>(&DataKey::Header(block_hash))
            .map(|r| !r.on_canonical_chain)
            .unwrap_or(false)
    }

    /// Core SPV verification gate.
    ///
    /// Validates:
    ///   1. The block header has valid proof-of-work (hash ≤ target encoded in header).
    ///   2. The tx_id is committed to the block via the Merkle proof.
    ///   3. The proof depth meets `min_confirmations` (Merkle-proof-depth
    ///      check — always enforced, unchanged from before this PR).
    ///   4. The tx_id has not been claimed before (replay protection).
    ///   5. IF the proof's block has been submitted via `submit_header`:
    ///      it must still be on the canonical chain (`RelayError::
    ///      ProofReferencesOrphanedBlock` if a reorg orphaned it), its
    ///      real height-based confirmation depth must also meet
    ///      `min_confirmations` (`FailureReason::InsufficientMerkleProofDepth`,
    ///      reused here since it's the same "not confirmed enough" concept
    ///      as the Merkle-depth check above), and it must not be stale
    ///      (`RelayError::StaleProof` if it's more than `max_stale_depth`
    ///      blocks behind the tip). A block never submitted via
    ///      `submit_header` skips this step entirely — see the module note
    ///      above `set_genesis_checkpoint` for why this is opt-in.
    ///
    /// On success, emits a `RelayOk` event and marks the tx as claimed.
    pub fn verify_and_claim(env: Env, proof: SpvProof) -> (Address, i128) {
        pause_state::require_not_paused(&env);
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");

        if proof.amount_sat <= 0 {
            panic!("amount must be positive");
        }
        if proof.block_header.len() != 80 {
            panic!("invalid block header length");
        }
        if proof.merkle_proof.len() < config.min_confirmations {
            panic!("insufficient merkle proof depth");
        }
        if proof.merkle_proof.len() > MAX_MERKLE_PROOF_DEPTH {
            panic!("merkle proof too deep");
        }
        if (proof.tx_index as u64) >= (1u64 << proof.merkle_proof.len()) {
            panic!("transaction index outside merkle proof");
        }
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));
        let crypto = BtcCryptoClient::new(&env, &config.crypto_contract);

        let claimed_key = DataKey::Claimed(proof.tx_id.clone());
        if env.storage().persistent().has(&claimed_key) {
            fail(&env, FailureReason::TxAlreadyClaimed);
        }

        let crypto = BtcCryptoClient::new(&env, &config.crypto_contract);
        // --- 2. Validate block header length ---
        if proof.block_header.len() != 80 {
            fail(&env, FailureReason::InvalidBlockHeaderLength);
        }

        // --- 3. Proof-of-Work check (delegated to crypto sub-contract) ---
        let header_hash = crypto.double_sha256(&proof.block_header);
        let target = crypto.extract_target(&proof.block_header);
        if !crypto.hash_meets_target(&header_hash, &target) {
            fail(&env, FailureReason::ProofOfWorkCheckFailed);
        }

        // --- 4. Merkle proof depth check ---
        if proof.merkle_proof.len() < config.min_confirmations {
            fail(&env, FailureReason::InsufficientMerkleProofDepth);
        }

        // --- 5. Merkle inclusion proof (delegated to crypto sub-contract) ---
        let merkle_root = crypto.extract_merkle_root(&proof.block_header);
        let computed_root = crypto.compute_merkle_root(
            &proof.tx_id,
            &proof.merkle_proof,
            &proof.tx_index,
        );
        if merkle_root != computed_root {
            panic!("merkle proof does not match block header");
        }

        env.storage().persistent().set(&claimed_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&claimed_key, CLAIMED_TX_TTL_LEDGERS, CLAIMED_TX_TTL_LEDGERS);
            fail(&env, FailureReason::MerkleProofInvalid);
        }

        // --- 5.5. Header-chain checks (opt-in — see method doc above) ---
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<DataKey, HeaderRecord>(&DataKey::Header(header_hash))
        {
            if !record.on_canonical_chain {
                env.panic_with_error(RelayError::ProofReferencesOrphanedBlock);
            }

            let checkpoint: Checkpoint = env
                .storage()
                .instance()
                .get(&DataKey::Checkpoint)
                .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized));

            let confirmation_depth = checkpoint.height.saturating_sub(record.height) + 1;
            if confirmation_depth < config.min_confirmations {
                fail(&env, FailureReason::InsufficientMerkleProofDepth);
            }

            let stale_depth = checkpoint.height.saturating_sub(record.height);
            if stale_depth > Self::max_stale_depth(&env) {
                env.panic_with_error(RelayError::StaleProof);
            }
        }

        // --- 6. Mark as claimed with TTL ---
        // Store claimed record with TTL to maintain audit trail while expiring old records.
        // (Persistent has no single set_with_ttl call — see persist_with_ttl above.)
        persist_with_ttl(&env, &claimed_key, &true, CLAIMED_TX_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("btc"), symbol_short!("relay_ok")),
            EvtRelayOk {
                version: 1,
                ledger: env.ledger().sequence(),
                actor: proof.recipient.clone(),
                tx_id: proof.tx_id,
                recipient: proof.recipient.clone(),
                amount_sat: proof.amount_sat,
            },
        );

        (proof.recipient, proof.amount_sat)
    }

    pub fn get_config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized")
    }

    pub fn is_claimed(env: Env, tx_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Claimed(tx_id))
    /// Returns the current config.
    pub fn get_config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| fail(&env, FailureReason::NotInitialized))
    }
}
