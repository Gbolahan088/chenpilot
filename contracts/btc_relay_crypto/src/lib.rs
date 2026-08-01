#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};

/// Sub-contract: Bitcoin cryptographic helpers extracted from btc_relay to
/// keep the main relay contract within Soroban's Wasm bytecode size limit.
///
/// Deployed independently and called by BtcRelayContract via contractclient.
#[contract]
pub struct BtcCryptoContract;

#[contractimpl]
impl BtcCryptoContract {
    /// Double-SHA256 of arbitrary bytes (Bitcoin's standard hash function).
    pub fn double_sha256(env: Env, data: Bytes) -> BytesN<32> {
        let first: BytesN<32> = env.crypto().sha256(&data).into();
        let first_bytes = Bytes::from_slice(&env, first.to_array().as_ref());
        env.crypto().sha256(&first_bytes).into()
    }

    /// Extract the 32-byte Merkle root from a Bitcoin block header.
    /// Bytes 36–67 (0-indexed) of the 80-byte header.
    pub fn extract_merkle_root(env: Env, header: Bytes) -> BytesN<32> {
        if header.len() != 80 {
            panic!("invalid block header length");
        }

        let mut arr = [0u8; 32];
        for i in 0..32usize {
            arr[i] = header.get(36 + i as u32).unwrap();
        }
        BytesN::from_array(&env, &arr)
    }

    /// Extract the 32-byte previous-block-hash field from a Bitcoin block
    /// header. Bytes 4–35 (0-indexed) of the 80-byte header, as stored
    /// on-wire (little-endian byte order — the same convention Bitcoin
    /// itself uses for hash fields; this is NOT byte-reversed to the
    /// display/big-endian order block explorers show).
    ///
    /// Used by the header-chain / reorg-detection logic in `btc_relay` to
    /// link a submitted header to its parent.
    pub fn extract_prev_block_hash(env: Env, header: Bytes) -> BytesN<32> {
        let mut arr = [0u8; 32];
        for i in 0..32usize {
            arr[i] = header.get(4 + i as u32).unwrap();
        }
        BytesN::from_array(&env, &arr)
    }

    /// Decode the compact-format target (nBits) from the block header.
    /// nBits is at bytes 72–75 (little-endian).
    /// Returns a 32-byte big-endian target value.
    pub fn extract_target(env: Env, header: Bytes) -> BytesN<32> {
        if header.len() != 80 {
            panic!("invalid block header length");
        }

        let b0 = header.get(72).unwrap() as u32;
        let b1 = header.get(73).unwrap() as u32;
        let b2 = header.get(74).unwrap() as u32;
        let b3 = header.get(75).unwrap() as u32;
        let nbits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);

        let exponent = (nbits >> 24) as usize;
        let mantissa = nbits & 0x007f_ffff;

        // The sign bit is not part of a valid proof-of-work target. Rejecting
        // it is important because the previous implementation silently
        // discarded it and accepted a different target than the header encoded.
        if (nbits & 0x0080_0000) != 0 {
            panic!("negative proof-of-work target");
        }
        if mantissa == 0 {
            panic!("zero proof-of-work target");
        }
        if exponent == 0 || exponent > 32 {
            panic!("proof-of-work target overflow");
        }

        let mut target = [0u8; 32];
        if exponent <= 3 {
            let shifted = mantissa >> (8 * (3 - exponent));
            target[31] = (shifted & 0xff) as u8;
            if exponent >= 2 {
                target[30] = ((shifted >> 8) & 0xff) as u8;
            }
            if exponent >= 3 {
                target[29] = ((shifted >> 16) & 0xff) as u8;
            }
        } else {
            let base = 32 - exponent;
            target[base] = ((mantissa >> 16) & 0xff) as u8;
            target[base + 1] = ((mantissa >> 8) & 0xff) as u8;
            target[base + 2] = (mantissa & 0xff) as u8;
        }

        BytesN::from_array(&env, &target)
    }

    /// Returns true if hash (big-endian) ≤ target (big-endian).
    pub fn hash_meets_target(hash: BytesN<32>, target: BytesN<32>) -> bool {
        let h = hash.to_array();
        let t = target.to_array();
        for i in 0..32 {
            if h[i] < t[i] {
                return true;
            }
            if h[i] > t[i] {
                return false;
            }
        }
        true
    }

    /// Compute the Merkle root by walking up the proof path.
    /// Uses Bitcoin's double-SHA256 at each step.
    pub fn compute_merkle_root(
        env: Env,
        tx_id: BytesN<32>,
        proof: Vec<BytesN<32>>,
        tx_index: u32,
    ) -> BytesN<32> {
        // A Bitcoin Merkle path cannot contain more than 32 levels for a
        // u32 transaction index. This also bounds attacker-controlled work.
        if proof.len() > 32 {
            panic!("merkle proof too deep");
        }

        let path_width = 1u64 << proof.len();
        if (tx_index as u64) >= path_width {
            panic!("transaction index outside merkle proof");
        }

        let mut current = tx_id;
        let mut index = tx_index;

        for i in 0..proof.len() {
            let sibling = proof.get(i).unwrap();
            let mut combined = Bytes::new(&env);

            if index % 2 == 0 {
                combined.extend_from_slice(current.to_array().as_ref());
                combined.extend_from_slice(sibling.to_array().as_ref());
            } else {
                combined.extend_from_slice(sibling.to_array().as_ref());
                combined.extend_from_slice(current.to_array().as_ref());
            }

            current = Self::double_sha256(env.clone(), combined);
            index /= 2;
        }

        current
    }
}
