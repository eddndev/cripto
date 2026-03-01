# Crypto

Interactive cryptography practices built with Rust, compiled to WebAssembly, running entirely in the browser.

Each practice implements a real cryptographic algorithm in Rust. Upload files, transform data, and see results in real time — no servers involved.

```
cargo build                                    # build all crates
wasm-pack build crates/stego --target web      # compile to WASM
cd web && npm run dev                          # start dev server
```

---

## Practices

### Steganography

Hide secret messages inside images using least-significant-bit (LSB) encoding. Upload a PNG, embed a message into the pixel data, and extract it back — changes invisible to the naked eye.

```rust
// crates/stego/src/lib.rs
#[wasm_bindgen]
pub fn greet() -> String {
    "Hello from stego!".into()
}
```

More practices coming as the project grows.

---

## How It Works

```
Rust crate (crates/stego/)
    │
    ├─► wasm-pack build --target web
    │       │
    │       └─► pkg/
    │            ├── stego_bg.wasm    WebAssembly binary
    │            ├── stego.js         JS bindings
    │            └── stego.d.ts       TypeScript types
    │
    └─► Astro frontend (web/)
            │
            └─► Imports WASM module
                Runs in the browser
                No server required
```

Rust handles the heavy computation. `wasm-bindgen` generates the JS glue. The Astro frontend imports the WASM module and provides the UI — everything executes client-side.

---

## Project Structure

```
crypto/
├── Cargo.toml              Workspace root
├── crates/
│   └── stego/              Steganography — LSB image encoding
│       ├── Cargo.toml      cdylib + rlib, wasm-bindgen
│       └── src/lib.rs
└── web/                    Astro landing + practice UIs
    ├── src/
    │   ├── components/     Header, Hero, Footer, PracticeCard
    │   ├── layouts/        Base layout
    │   └── pages/          Routes
    └── public/             Static assets
```

---

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Node.js](https://nodejs.org/) (v18+)

### Build & Run

```bash
# Build the Rust crate
cargo build

# Compile to WASM
wasm-pack build crates/stego --target web

# Install frontend dependencies
cd web && npm install

# Start dev server
npm run dev
```

### Test

```bash
cargo test --workspace
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Algorithms | Rust |
| WASM bindings | wasm-bindgen |
| Frontend | Astro, GSAP, Lenis |
| Hosting | Cloudflare Pages |

---

## License

MIT
