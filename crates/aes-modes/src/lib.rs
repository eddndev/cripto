use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use rand::{thread_rng, RngCore};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const BLOCK: usize = 16;

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn to_hex(b: &[u8]) -> String {
    hex::encode(b)
}

// ---- helpers exposed to JS --------------------------------------------------

#[wasm_bindgen]
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    thread_rng().fill_bytes(&mut v);
    v
}

#[wasm_bindgen]
pub fn random_hex(n: usize) -> String {
    to_hex(&random_bytes(n))
}

/// PBKDF2-HMAC-SHA256 → `out_len` bytes, returned as lowercase hex.
#[wasm_bindgen]
pub fn derive_key(passphrase: &str, salt: &[u8], iters: u32, out_len: usize) -> String {
    let mut out = vec![0u8; out_len];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iters, &mut out);
    to_hex(&out)
}

// ---- core ------------------------------------------------------------------

#[derive(Serialize, Default)]
struct BlockTrace {
    index: usize,
    /// Raw input block as it enters the round (plaintext or ciphertext block).
    input: String,
    /// Value fed to the AES block function (after any XOR step).
    aes_in: String,
    /// Output of the AES block function.
    aes_out: String,
    /// Value XORed with `aes_out` (CBC dec, CFB, OFB, CTR) or `aes_in` step (CBC enc).
    /// Empty when not applicable.
    xor_with: String,
    /// Final output block of this round (after XOR / padding strip).
    output: String,
    /// CTR-only: the counter value used.
    counter: String,
}

#[derive(Serialize)]
struct ProcessOut {
    ciphertext: Vec<u8>,
    blocks_total: usize,
    truncated: bool,
    /// Up to MAX_TRACE entries: when total exceeds MAX_TRACE we keep the first
    /// (MAX_TRACE - 2) blocks and the last 2.
    trace: Vec<BlockTrace>,
    /// Optional padding info (ECB/CBC) — hex of removed/added pad bytes.
    pad_info: Option<String>,
}

const MAX_TRACE: usize = 12;

fn xor16(a: &[u8; BLOCK], b: &[u8; BLOCK]) -> [u8; BLOCK] {
    let mut out = [0u8; BLOCK];
    for i in 0..BLOCK {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn xor_n(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b.iter()).map(|(x, y)| x ^ y).collect()
}

fn pkcs7_pad(data: &[u8]) -> (Vec<u8>, u8) {
    let pad = (BLOCK - (data.len() % BLOCK)) as u8;
    let mut out = data.to_vec();
    out.extend(std::iter::repeat(pad).take(pad as usize));
    (out, pad)
}

fn pkcs7_unpad(data: &[u8]) -> Result<(&[u8], u8), JsValue> {
    if data.is_empty() || data.len() % BLOCK != 0 {
        return Err(err("ciphertext not a multiple of 16 bytes"));
    }
    let pad = *data.last().unwrap();
    if pad == 0 || pad as usize > BLOCK {
        return Err(err("invalid PKCS#7 padding"));
    }
    let cut = data.len() - pad as usize;
    for &b in &data[cut..] {
        if b != pad {
            return Err(err("invalid PKCS#7 padding"));
        }
    }
    Ok((&data[..cut], pad))
}

fn aes_enc(cipher: &Aes128, block: &[u8; BLOCK]) -> [u8; BLOCK] {
    let mut b = aes::Block::clone_from_slice(block);
    cipher.encrypt_block(&mut b);
    let mut out = [0u8; BLOCK];
    out.copy_from_slice(&b);
    out
}

fn aes_dec(cipher: &Aes128, block: &[u8; BLOCK]) -> [u8; BLOCK] {
    let mut b = aes::Block::clone_from_slice(block);
    cipher.decrypt_block(&mut b);
    let mut out = [0u8; BLOCK];
    out.copy_from_slice(&b);
    out
}

fn parse_block(b: &[u8]) -> [u8; BLOCK] {
    let mut a = [0u8; BLOCK];
    a.copy_from_slice(b);
    a
}

fn require_key(key: &[u8]) -> Result<[u8; BLOCK], JsValue> {
    if key.len() != BLOCK {
        return Err(err(format!("key must be 16 bytes (got {})", key.len())));
    }
    Ok(parse_block(key))
}

fn require_iv(iv: &[u8], mode: &str) -> Result<[u8; BLOCK], JsValue> {
    if mode == "ECB" {
        return Ok([0u8; BLOCK]);
    }
    if iv.len() != BLOCK {
        return Err(err(format!(
            "{} requires a 16-byte IV (got {})",
            mode,
            iv.len()
        )));
    }
    Ok(parse_block(iv))
}

fn ctr_increment(counter: &mut [u8; BLOCK]) {
    // Treat full block as big-endian counter (NIST SP 800-38A test vectors use this layout).
    for i in (0..BLOCK).rev() {
        let (v, carry) = counter[i].overflowing_add(1);
        counter[i] = v;
        if !carry {
            break;
        }
    }
}

fn pack_trace(mut full: Vec<BlockTrace>) -> (Vec<BlockTrace>, bool) {
    if full.len() <= MAX_TRACE {
        return (full, false);
    }
    let head = MAX_TRACE - 2;
    let tail: Vec<BlockTrace> = full.drain(full.len() - 2..).collect();
    let mut out: Vec<BlockTrace> = full.into_iter().take(head).collect();
    out.extend(tail);
    (out, true)
}

// ---- modes -----------------------------------------------------------------

fn encrypt_ecb(cipher: &Aes128, pt: &[u8], trace: &mut Vec<BlockTrace>) -> (Vec<u8>, Option<String>) {
    let (padded, pad) = pkcs7_pad(pt);
    let mut ct = Vec::with_capacity(padded.len());
    for (i, chunk) in padded.chunks(BLOCK).enumerate() {
        let p = parse_block(chunk);
        let c = aes_enc(cipher, &p);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(&p),
            aes_in: to_hex(&p),
            aes_out: to_hex(&c),
            xor_with: String::new(),
            output: to_hex(&c),
            counter: String::new(),
        });
        ct.extend_from_slice(&c);
    }
    (ct, Some(format!("PKCS#7 pad: 0x{:02x} ({} byte{})", pad, pad, if pad == 1 { "" } else { "s" })))
}

fn decrypt_ecb(cipher: &Aes128, ct: &[u8], trace: &mut Vec<BlockTrace>) -> Result<(Vec<u8>, Option<String>), JsValue> {
    if ct.is_empty() || ct.len() % BLOCK != 0 {
        return Err(err("ciphertext not a multiple of 16 bytes"));
    }
    let mut pt = Vec::with_capacity(ct.len());
    for (i, chunk) in ct.chunks(BLOCK).enumerate() {
        let c = parse_block(chunk);
        let p = aes_dec(cipher, &c);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(&c),
            aes_in: to_hex(&c),
            aes_out: to_hex(&p),
            xor_with: String::new(),
            output: to_hex(&p),
            counter: String::new(),
        });
        pt.extend_from_slice(&p);
    }
    let (stripped, pad) = pkcs7_unpad(&pt)?;
    let info = Some(format!("PKCS#7 strip: 0x{:02x} ({} byte{})", pad, pad, if pad == 1 { "" } else { "s" }));
    Ok((stripped.to_vec(), info))
}

fn encrypt_cbc(
    cipher: &Aes128,
    iv: &[u8; BLOCK],
    pt: &[u8],
    trace: &mut Vec<BlockTrace>,
) -> (Vec<u8>, Option<String>) {
    let (padded, pad) = pkcs7_pad(pt);
    let mut ct = Vec::with_capacity(padded.len());
    let mut prev = *iv;
    for (i, chunk) in padded.chunks(BLOCK).enumerate() {
        let p = parse_block(chunk);
        let x = xor16(&p, &prev);
        let c = aes_enc(cipher, &x);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(&p),
            aes_in: to_hex(&x),
            aes_out: to_hex(&c),
            xor_with: to_hex(&prev),
            output: to_hex(&c),
            counter: String::new(),
        });
        ct.extend_from_slice(&c);
        prev = c;
    }
    (ct, Some(format!("PKCS#7 pad: 0x{:02x} ({} byte{})", pad, pad, if pad == 1 { "" } else { "s" })))
}

fn decrypt_cbc(
    cipher: &Aes128,
    iv: &[u8; BLOCK],
    ct: &[u8],
    trace: &mut Vec<BlockTrace>,
) -> Result<(Vec<u8>, Option<String>), JsValue> {
    if ct.is_empty() || ct.len() % BLOCK != 0 {
        return Err(err("ciphertext not a multiple of 16 bytes"));
    }
    let mut pt = Vec::with_capacity(ct.len());
    let mut prev = *iv;
    for (i, chunk) in ct.chunks(BLOCK).enumerate() {
        let c = parse_block(chunk);
        let d = aes_dec(cipher, &c);
        let p = xor16(&d, &prev);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(&c),
            aes_in: to_hex(&c),
            aes_out: to_hex(&d),
            xor_with: to_hex(&prev),
            output: to_hex(&p),
            counter: String::new(),
        });
        pt.extend_from_slice(&p);
        prev = c;
    }
    let (stripped, pad) = pkcs7_unpad(&pt)?;
    let info = Some(format!("PKCS#7 strip: 0x{:02x} ({} byte{})", pad, pad, if pad == 1 { "" } else { "s" }));
    Ok((stripped.to_vec(), info))
}

/// CFB-128 (full-block feedback).
fn process_cfb(
    cipher: &Aes128,
    iv: &[u8; BLOCK],
    data: &[u8],
    encrypt: bool,
    trace: &mut Vec<BlockTrace>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut feedback = *iv;
    for (i, chunk) in data.chunks(BLOCK).enumerate() {
        let ks = aes_enc(cipher, &feedback);
        let xored = xor_n(chunk, &ks[..chunk.len()]);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(chunk),
            aes_in: to_hex(&feedback),
            aes_out: to_hex(&ks),
            xor_with: to_hex(&ks[..chunk.len()]),
            output: to_hex(&xored),
            counter: String::new(),
        });
        if encrypt {
            // feedback = ciphertext (pad short final block? CFB usually doesn't — last block is partial)
            if chunk.len() == BLOCK {
                feedback = parse_block(&xored);
            }
        } else {
            if chunk.len() == BLOCK {
                feedback = parse_block(chunk);
            }
        }
        out.extend_from_slice(&xored);
    }
    out
}

/// OFB.
fn process_ofb(
    cipher: &Aes128,
    iv: &[u8; BLOCK],
    data: &[u8],
    trace: &mut Vec<BlockTrace>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut o = *iv;
    for (i, chunk) in data.chunks(BLOCK).enumerate() {
        let prev = o;
        o = aes_enc(cipher, &o);
        let xored = xor_n(chunk, &o[..chunk.len()]);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(chunk),
            aes_in: to_hex(&prev),
            aes_out: to_hex(&o),
            xor_with: to_hex(&o[..chunk.len()]),
            output: to_hex(&xored),
            counter: String::new(),
        });
        out.extend_from_slice(&xored);
    }
    out
}

/// CTR (full-block big-endian counter starting from the IV).
fn process_ctr(
    cipher: &Aes128,
    iv: &[u8; BLOCK],
    data: &[u8],
    trace: &mut Vec<BlockTrace>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut counter = *iv;
    for (i, chunk) in data.chunks(BLOCK).enumerate() {
        let ks = aes_enc(cipher, &counter);
        let xored = xor_n(chunk, &ks[..chunk.len()]);
        trace.push(BlockTrace {
            index: i,
            input: to_hex(chunk),
            aes_in: to_hex(&counter),
            aes_out: to_hex(&ks),
            xor_with: to_hex(&ks[..chunk.len()]),
            output: to_hex(&xored),
            counter: to_hex(&counter),
        });
        ctr_increment(&mut counter);
        out.extend_from_slice(&xored);
    }
    out
}

#[wasm_bindgen]
pub fn process(
    direction: &str,
    mode: &str,
    key: &[u8],
    iv: &[u8],
    data: &[u8],
) -> Result<JsValue, JsValue> {
    let key_arr = require_key(key)?;
    let iv_arr = require_iv(iv, mode)?;
    let cipher = Aes128::new(&aes::cipher::generic_array::GenericArray::from(key_arr));

    let encrypt = match direction {
        "encrypt" => true,
        "decrypt" => false,
        _ => return Err(err("direction must be encrypt|decrypt")),
    };

    let mut trace: Vec<BlockTrace> = Vec::new();
    let (out_bytes, pad_info) = match (mode, encrypt) {
        ("ECB", true) => encrypt_ecb(&cipher, data, &mut trace),
        ("ECB", false) => decrypt_ecb(&cipher, data, &mut trace)?,
        ("CBC", true) => encrypt_cbc(&cipher, &iv_arr, data, &mut trace),
        ("CBC", false) => decrypt_cbc(&cipher, &iv_arr, data, &mut trace)?,
        ("CFB", _) => (process_cfb(&cipher, &iv_arr, data, encrypt, &mut trace), None),
        ("OFB", _) => (process_ofb(&cipher, &iv_arr, data, &mut trace), None),
        ("CTR", _) => (process_ctr(&cipher, &iv_arr, data, &mut trace), None),
        (m, _) => return Err(err(format!("unknown mode {}", m))),
    };

    let blocks_total = trace.len();
    let (trace, truncated) = pack_trace(trace);

    let out = ProcessOut {
        ciphertext: out_bytes,
        blocks_total,
        truncated,
        trace,
        pad_info,
    };
    serde_wasm_bindgen::to_value(&out).map_err(err)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn k() -> [u8; 16] {
        *b"YELLOW SUBMARINE"
    }
    fn iv() -> [u8; 16] {
        [0u8; 16]
    }

    fn run(direction: &str, mode: &str, data: &[u8]) -> Vec<u8> {
        let cipher = Aes128::new(&aes::cipher::generic_array::GenericArray::from(k()));
        let mut trace = Vec::new();
        match (mode, direction) {
            ("ECB", "encrypt") => encrypt_ecb(&cipher, data, &mut trace).0,
            ("ECB", "decrypt") => decrypt_ecb(&cipher, data, &mut trace).unwrap().0,
            ("CBC", "encrypt") => encrypt_cbc(&cipher, &iv(), data, &mut trace).0,
            ("CBC", "decrypt") => decrypt_cbc(&cipher, &iv(), data, &mut trace).unwrap().0,
            ("CFB", "encrypt") => process_cfb(&cipher, &iv(), data, true, &mut trace),
            ("CFB", "decrypt") => process_cfb(&cipher, &iv(), data, false, &mut trace),
            ("OFB", _) => process_ofb(&cipher, &iv(), data, &mut trace),
            ("CTR", _) => process_ctr(&cipher, &iv(), data, &mut trace),
            _ => unreachable!(),
        }
    }

    #[test]
    fn round_trip_all_modes() {
        let pt = b"the quick brown fox jumps over the lazy dog. AES-128 modes round trip!";
        for mode in ["ECB", "CBC", "CFB", "OFB", "CTR"] {
            let ct = run("encrypt", mode, pt);
            let back = run("decrypt", mode, &ct);
            assert_eq!(back, pt, "mode {}", mode);
        }
    }

    #[test]
    fn nist_ecb_vector() {
        // NIST SP 800-38A F.1.1
        let key = hex::decode("2b7e151628aed2a6abf7158809cf4f3c").unwrap();
        let pt = hex::decode("6bc1bee22e409f96e93d7e117393172a").unwrap();
        let ct_exp = hex::decode("3ad77bb40d7a3660a89ecaf32466ef97").unwrap();
        let cipher = Aes128::new(&aes::cipher::generic_array::GenericArray::clone_from_slice(&key));
        let b = parse_block(&pt);
        let c = aes_enc(&cipher, &b);
        assert_eq!(c.to_vec(), ct_exp);
    }

    #[test]
    fn nist_ctr_vector() {
        // SP 800-38A F.5.1 (CTR-AES128.Encrypt)
        let key = hex::decode("2b7e151628aed2a6abf7158809cf4f3c").unwrap();
        let iv = hex::decode("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").unwrap();
        let pt = hex::decode(
            "6bc1bee22e409f96e93d7e117393172a\
             ae2d8a571e03ac9c9eb76fac45af8e51\
             30c81c46a35ce411e5fbc1191a0a52ef\
             f69f2445df4f9b17ad2b417be66c3710",
        )
        .unwrap();
        let exp = hex::decode(
            "874d6191b620e3261bef6864990db6ce\
             9806f66b7970fdff8617187bb9fffdff\
             5ae4df3edbd5d35e5b4f09020db03eab\
             1e031dda2fbe03d1792170a0f3009cee",
        )
        .unwrap();
        let cipher = Aes128::new(&aes::cipher::generic_array::GenericArray::clone_from_slice(&key));
        let mut trace = Vec::new();
        let got = process_ctr(&cipher, &parse_block(&iv), &pt, &mut trace);
        assert_eq!(got, exp);
    }

    #[test]
    fn pbkdf2_known_vector() {
        // RFC 6070-style but with SHA256 — we just check determinism + length.
        let h1 = derive_key("password", b"salt", 1000, 16);
        let h2 = derive_key("password", b"salt", 1000, 16);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 32);
    }
}
