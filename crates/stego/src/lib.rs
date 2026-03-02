use wasm_bindgen::prelude::*;

struct BmpInfo {
    pixel_offset: usize,
    width: u32,
    height: u32,
}

fn parse_bmp(data: &[u8]) -> Result<BmpInfo, String> {
    if data.len() < 54 {
        return Err("File too small to be a valid BMP".into());
    }
    if data[0] != b'B' || data[1] != b'M' {
        return Err("Not a BMP file (missing BM signature)".into());
    }

    let pixel_offset = u32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;
    // DIB header starts at offset 14; width is at 18, height at 22, bpp at 28
    let width = u32::from_le_bytes([data[18], data[19], data[20], data[21]]);
    let height_raw = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
    let height = height_raw.unsigned_abs();
    let bpp = u16::from_le_bytes([data[28], data[29]]);

    if bpp != 24 {
        return Err(format!("Only 24-bit BMP supported, got {bpp}-bit"));
    }
    if pixel_offset >= data.len() {
        return Err("Invalid pixel data offset".into());
    }

    Ok(BmpInfo {
        pixel_offset,
        width,
        height,
    })
}

fn usable_byte_indices(pixel_offset: usize, width: u32, height: u32) -> Vec<usize> {
    let row_data = width as usize * 3;
    let row_stride = (row_data + 3) & !3; // align to 4 bytes
    let mut indices = Vec::with_capacity(row_data * height as usize);

    for row in 0..height as usize {
        let row_start = pixel_offset + row * row_stride;
        for col in 0..row_data {
            indices.push(row_start + col);
        }
    }

    indices
}

#[wasm_bindgen]
pub fn encode(bmp_data: &[u8], message: &[u8]) -> Result<Vec<u8>, String> {
    let info = parse_bmp(bmp_data)?;
    let indices = usable_byte_indices(info.pixel_offset, info.width, info.height);

    let total_bits = (4 + message.len()) * 8;
    if total_bits > indices.len() {
        let available = indices.len() / 8;
        let available = if available >= 4 { available - 4 } else { 0 };
        return Err(format!(
            "Message too large: need {} bytes but only {} available",
            message.len(),
            available
        ));
    }

    let len_bytes = (message.len() as u32).to_be_bytes();
    let payload: Vec<u8> = len_bytes.iter().chain(message.iter()).copied().collect();

    let mut data = bmp_data.to_vec();
    let mut bit_idx = 0;

    for byte in &payload {
        for bit_pos in (0..8).rev() {
            let bit = (byte >> bit_pos) & 1;
            let i = indices[bit_idx];
            data[i] = (data[i] & 0xFE) | bit;
            bit_idx += 1;
        }
    }

    Ok(data)
}

#[wasm_bindgen]
pub fn decode(bmp_data: &[u8]) -> Result<Vec<u8>, String> {
    let info = parse_bmp(bmp_data)?;
    let indices = usable_byte_indices(info.pixel_offset, info.width, info.height);

    if indices.len() < 32 {
        return Err("Image too small to contain a hidden message".into());
    }

    // Read 32 bits for length
    let mut len_bytes = [0u8; 4];
    for (byte_idx, len_byte) in len_bytes.iter_mut().enumerate() {
        for bit_pos in (0..8).rev() {
            let bit_idx = byte_idx * 8 + (7 - bit_pos);
            let bit = bmp_data[indices[bit_idx]] & 1;
            *len_byte |= bit << bit_pos;
        }
    }

    let msg_len = u32::from_be_bytes(len_bytes) as usize;
    let total_bits = (4 + msg_len) * 8;

    if total_bits > indices.len() {
        return Err(format!(
            "Encoded length ({msg_len} bytes) exceeds image capacity"
        ));
    }

    let mut message = vec![0u8; msg_len];
    for (byte_idx, msg_byte) in message.iter_mut().enumerate() {
        for bit_pos in (0..8).rev() {
            let bit_idx = (4 + byte_idx) * 8 + (7 - bit_pos);
            let bit = bmp_data[indices[bit_idx]] & 1;
            *msg_byte |= bit << bit_pos;
        }
    }

    Ok(message)
}

#[wasm_bindgen]
pub fn capacity(bmp_data: &[u8]) -> Result<u32, String> {
    let info = parse_bmp(bmp_data)?;
    let total_usable = (info.width as usize * 3 * info.height as usize) / 8;
    if total_usable < 4 {
        return Ok(0);
    }
    Ok((total_usable - 4) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a minimal 24-bit BMP in memory with the given dimensions.
    fn make_bmp(width: u32, height: u32) -> Vec<u8> {
        let row_data = width as usize * 3;
        let row_stride = (row_data + 3) & !3;
        let pixel_data_size = row_stride * height as usize;
        let file_size = 54 + pixel_data_size;

        let mut data = vec![0u8; file_size];

        // BM signature
        data[0] = b'B';
        data[1] = b'M';

        // File size
        let fs = file_size as u32;
        data[2..6].copy_from_slice(&fs.to_le_bytes());

        // Pixel data offset
        data[10..14].copy_from_slice(&54u32.to_le_bytes());

        // DIB header size (BITMAPINFOHEADER = 40)
        data[14..18].copy_from_slice(&40u32.to_le_bytes());

        // Width
        data[18..22].copy_from_slice(&width.to_le_bytes());

        // Height (positive = bottom-up)
        data[22..26].copy_from_slice(&(height as i32).to_le_bytes());

        // Planes
        data[26..28].copy_from_slice(&1u16.to_le_bytes());

        // Bits per pixel
        data[28..30].copy_from_slice(&24u16.to_le_bytes());

        // Fill pixel data with 0xFF (white)
        for i in 54..data.len() {
            data[i] = 0xFF;
        }

        data
    }

    #[test]
    fn roundtrip_basic() {
        let bmp = make_bmp(10, 10);
        let message = b"Hello, steganography!";

        let encoded = encode(&bmp, message).unwrap();
        let decoded = decode(&encoded).unwrap();

        assert_eq!(decoded, message);
    }

    #[test]
    fn roundtrip_empty_message() {
        let bmp = make_bmp(10, 10);
        let message = b"";

        let encoded = encode(&bmp, message).unwrap();
        let decoded = decode(&encoded).unwrap();

        assert_eq!(decoded, message);
    }

    #[test]
    fn roundtrip_binary_data() {
        let bmp = make_bmp(30, 24);
        let message: Vec<u8> = (0..=255).collect();

        let encoded = encode(&bmp, &message).unwrap();
        let decoded = decode(&encoded).unwrap();

        assert_eq!(decoded, message);
    }

    #[test]
    fn capacity_calculation() {
        let bmp = make_bmp(10, 10);
        let cap = capacity(&bmp).unwrap();
        // 10 * 3 * 10 = 300 usable bytes, 300 / 8 = 37, 37 - 4 = 33
        assert_eq!(cap, 33);
    }

    #[test]
    fn capacity_with_padding() {
        // Width 5: row_data = 15, row_stride = 16 (1 byte padding)
        // But usable bytes = 5*3*4 = 60, 60/8 = 7, 7-4 = 3
        let bmp = make_bmp(5, 4);
        let cap = capacity(&bmp).unwrap();
        assert_eq!(cap, 3);
    }

    #[test]
    fn roundtrip_with_padding() {
        // Width 5 causes 1 byte of row padding
        let bmp = make_bmp(5, 10);
        let msg = b"Hi";

        let encoded = encode(&bmp, msg).unwrap();
        let decoded = decode(&encoded).unwrap();

        assert_eq!(decoded, msg);
    }

    #[test]
    fn reject_non_bmp() {
        let data = vec![0u8; 100];
        assert!(encode(&data, b"test").is_err());
        assert!(decode(&data).is_err());
        assert!(capacity(&data).is_err());
    }

    #[test]
    fn reject_too_small() {
        let data = vec![0u8; 10];
        assert!(encode(&data, b"test").is_err());
    }

    #[test]
    fn reject_message_exceeds_capacity() {
        let bmp = make_bmp(2, 2);
        // 2*3*2 = 12 usable bytes, 12/8 = 1, 1-4 = negative → capacity 0
        let long_msg = vec![b'A'; 100];
        assert!(encode(&bmp, &long_msg).is_err());
    }

    #[test]
    fn parse_bmp_rejects_non_24bit() {
        let mut data = make_bmp(10, 10);
        // Change bpp to 32
        data[28..30].copy_from_slice(&32u16.to_le_bytes());
        assert!(parse_bmp(&data).is_err());
    }
}
