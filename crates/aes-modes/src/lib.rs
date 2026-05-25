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
    /// When image-container mode was used: format name + header length + tail length.
    image_info: Option<String>,
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
        image_info: None,
    };
    serde_wasm_bindgen::to_value(&out).map_err(err)
}

// ---- BMP image-container mode ---------------------------------------------
//
// Length-preserving variant: encrypt only the **actual pixel bytes** of a 24-bit
// BMP (skipping per-row 4-byte padding) so every byte of the BMP container —
// magic, file header, DIB header, row padding — is preserved verbatim. ECB/CBC
// pass the trailing <16-byte tail through unchanged; CFB/OFB/CTR are naturally
// length-preserving. This mirrors the convention used by the stego practice.

struct BmpInfo {
    pixel_offset: usize,
    width: u32,
    height: u32,
}

fn parse_bmp(data: &[u8]) -> Result<BmpInfo, JsValue> {
    if data.len() < 54 {
        return Err(err("File too small to be a valid BMP"));
    }
    if data[0] != b'B' || data[1] != b'M' {
        return Err(err("Not a BMP file (missing BM signature)"));
    }
    let pixel_offset = u32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;
    let width = u32::from_le_bytes([data[18], data[19], data[20], data[21]]);
    let height_raw = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
    let height = height_raw.unsigned_abs();
    let bpp = u16::from_le_bytes([data[28], data[29]]);
    if bpp != 24 {
        return Err(err(format!("Only 24-bit BMP supported, got {bpp}-bit")));
    }
    if pixel_offset >= data.len() {
        return Err(err("Invalid pixel data offset"));
    }
    Ok(BmpInfo { pixel_offset, width, height })
}

fn usable_byte_indices(info: &BmpInfo) -> Vec<usize> {
    let row_data = info.width as usize * 3;
    let row_stride = (row_data + 3) & !3;
    let mut indices = Vec::with_capacity(row_data * info.height as usize);
    for row in 0..info.height as usize {
        let row_start = info.pixel_offset + row * row_stride;
        for col in 0..row_data {
            indices.push(row_start + col);
        }
    }
    indices
}

fn process_body_no_pad(
    cipher: &Aes128,
    mode: &str,
    iv: &[u8; BLOCK],
    body: &[u8],
    encrypt: bool,
    trace: &mut Vec<BlockTrace>,
) -> Result<Vec<u8>, JsValue> {
    Ok(match mode {
        "ECB" => {
            // Process full blocks only; trailing partial is appended unchanged.
            let full = (body.len() / BLOCK) * BLOCK;
            let mut out = Vec::with_capacity(body.len());
            for (i, chunk) in body[..full].chunks(BLOCK).enumerate() {
                let p = parse_block(chunk);
                let c = if encrypt { aes_enc(cipher, &p) } else { aes_dec(cipher, &p) };
                trace.push(BlockTrace {
                    index: i,
                    input: to_hex(&p),
                    aes_in: to_hex(&p),
                    aes_out: to_hex(&c),
                    xor_with: String::new(),
                    output: to_hex(&c),
                    counter: String::new(),
                });
                out.extend_from_slice(&c);
            }
            out.extend_from_slice(&body[full..]);
            out
        }
        "CBC" => {
            let full = (body.len() / BLOCK) * BLOCK;
            let mut out = Vec::with_capacity(body.len());
            let mut prev = *iv;
            for (i, chunk) in body[..full].chunks(BLOCK).enumerate() {
                let block = parse_block(chunk);
                if encrypt {
                    let x = xor16(&block, &prev);
                    let c = aes_enc(cipher, &x);
                    trace.push(BlockTrace {
                        index: i,
                        input: to_hex(&block),
                        aes_in: to_hex(&x),
                        aes_out: to_hex(&c),
                        xor_with: to_hex(&prev),
                        output: to_hex(&c),
                        counter: String::new(),
                    });
                    out.extend_from_slice(&c);
                    prev = c;
                } else {
                    let d = aes_dec(cipher, &block);
                    let p = xor16(&d, &prev);
                    trace.push(BlockTrace {
                        index: i,
                        input: to_hex(&block),
                        aes_in: to_hex(&block),
                        aes_out: to_hex(&d),
                        xor_with: to_hex(&prev),
                        output: to_hex(&p),
                        counter: String::new(),
                    });
                    out.extend_from_slice(&p);
                    prev = block;
                }
            }
            out.extend_from_slice(&body[full..]);
            out
        }
        "CFB" => process_cfb(cipher, iv, body, encrypt, trace),
        "OFB" => process_ofb(cipher, iv, body, trace),
        "CTR" => process_ctr(cipher, iv, body, trace),
        m => return Err(err(format!("unknown mode {}", m))),
    })
}

#[wasm_bindgen]
pub fn process_image(
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

    let bmp = parse_bmp(data)?;
    let indices = usable_byte_indices(&bmp);
    let pixel_bytes: Vec<u8> = indices.iter().map(|&i| data[i]).collect();
    let body_len = pixel_bytes.len();
    let tail_len = body_len % BLOCK;

    let mut trace: Vec<BlockTrace> = Vec::new();
    let processed = process_body_no_pad(&cipher, mode, &iv_arr, &pixel_bytes, encrypt, &mut trace)?;

    let mut out = data.to_vec();
    for (i, &b) in processed.iter().enumerate() {
        out[indices[i]] = b;
    }

    let blocks_total = trace.len();
    let (trace, truncated) = pack_trace(trace);

    let info = format!(
        "BMP {}×{} — header {} B, pixel bytes {}{}",
        bmp.width,
        bmp.height,
        bmp.pixel_offset,
        body_len,
        if (mode == "ECB" || mode == "CBC") && tail_len > 0 {
            format!(" ({} trailing byte{} unchanged — kept length aligned)", tail_len, if tail_len == 1 { "" } else { "s" })
        } else {
            String::new()
        }
    );

    let result = ProcessOut {
        ciphertext: out,
        blocks_total,
        truncated,
        trace,
        pad_info: None,
        image_info: Some(info),
    };
    serde_wasm_bindgen::to_value(&result).map_err(err)
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

    /// Synthesize a minimal 24-bit BMP with the same layout the stego crate
    /// uses, so we can run process_image natively and verify the output.
    fn make_bmp(width: u32, height: u32) -> Vec<u8> {
        let row_data = width as usize * 3;
        let row_stride = (row_data + 3) & !3;
        let pixel_data_size = row_stride * height as usize;
        let file_size = 54 + pixel_data_size;
        let mut data = vec![0u8; file_size];
        data[0] = b'B';
        data[1] = b'M';
        data[2..6].copy_from_slice(&(file_size as u32).to_le_bytes());
        data[10..14].copy_from_slice(&54u32.to_le_bytes());
        data[14..18].copy_from_slice(&40u32.to_le_bytes());
        data[18..22].copy_from_slice(&width.to_le_bytes());
        data[22..26].copy_from_slice(&(height as i32).to_le_bytes());
        data[26..28].copy_from_slice(&1u16.to_le_bytes());
        data[28..30].copy_from_slice(&24u16.to_le_bytes());
        for i in 54..data.len() {
            data[i] = ((i - 54) & 0xff) as u8;
        }
        data
    }

    fn run_image(direction: &str, mode: &str, key: &[u8; 16], iv: &[u8; 16], data: &[u8]) -> Vec<u8> {
        let cipher = Aes128::new(&aes::cipher::generic_array::GenericArray::clone_from_slice(key));
        let bmp = parse_bmp(data).unwrap();
        let indices = usable_byte_indices(&bmp);
        let pixels: Vec<u8> = indices.iter().map(|&i| data[i]).collect();
        let mut trace = Vec::new();
        let encrypt = direction == "encrypt";
        let processed =
            process_body_no_pad(&cipher, mode, iv, &pixels, encrypt, &mut trace).unwrap();
        let mut out = data.to_vec();
        for (i, &b) in processed.iter().enumerate() {
            out[indices[i]] = b;
        }
        out
    }

    #[test]
    fn process_image_preserves_bmp_header_all_modes() {
        let bmp = make_bmp(13, 7); // 13×3=39 row bytes → 40 with padding, padding > 0
        let key = [0x11u8; 16];
        let iv = [0x22u8; 16];
        for mode in ["ECB", "CBC", "CFB", "OFB", "CTR"] {
            let enc = run_image("encrypt", mode, &key, &iv, &bmp);
            // 1) Same length.
            assert_eq!(enc.len(), bmp.len(), "{mode}: length must be preserved");
            // 2) BM magic intact.
            assert_eq!(&enc[0..2], b"BM", "{mode}: BM magic lost");
            // 3) Full 54-byte header intact.
            assert_eq!(&enc[0..54], &bmp[0..54], "{mode}: header bytes changed");
            // 4) Per-row 1-byte padding is preserved (must equal the original).
            //    Row stride is 40, row_data is 39, so byte at offset 54+row*40+39 is padding.
            for row in 0..7 {
                let pad_byte = 54 + row * 40 + 39;
                assert_eq!(
                    enc[pad_byte], bmp[pad_byte],
                    "{mode}: row {row} padding byte at {pad_byte} changed"
                );
            }
            // 5) Pixel bytes actually changed (not no-op).
            let pixel_bytes_changed = enc.iter().zip(bmp.iter()).filter(|(a, b)| a != b).count();
            assert!(pixel_bytes_changed > 0, "{mode}: nothing was encrypted");
            // 6) Round-trip back to plaintext.
            let back = run_image("decrypt", mode, &key, &iv, &enc);
            assert_eq!(back, bmp, "{mode}: round-trip failed");
        }
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
