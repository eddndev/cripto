import { useEffect, useRef, useState } from 'react';

export type BlockTrace = {
  index: number;
  input: string;
  aes_in: string;
  aes_out: string;
  xor_with: string;
  output: string;
  counter: string;
};

export type ProcessOut = {
  ciphertext: Uint8Array;
  blocks_total: number;
  truncated: boolean;
  trace: BlockTrace[];
  pad_info: string | null;
  image_info: string | null;
};

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  random_bytes: (n: number) => Uint8Array;
  random_hex: (n: number) => string;
  derive_key: (passphrase: string, salt: Uint8Array, iters: number, out_len: number) => string;
  process: (
    direction: 'encrypt' | 'decrypt',
    mode: string,
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ) => ProcessOut;
  process_image: (
    direction: 'encrypt' | 'decrypt',
    mode: string,
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ) => ProcessOut;
};

type Status = 'idle' | 'loading' | 'ready' | 'error';

export type AesApi = {
  status: Status;
  error: string | null;
  randomHex: (n: number) => string;
  deriveKey: (passphrase: string, salt: Uint8Array, iters: number, outLen: number) => string;
  process: (
    direction: 'encrypt' | 'decrypt',
    mode: string,
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ) => ProcessOut;
  processImage: (
    direction: 'encrypt' | 'decrypt',
    mode: string,
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ) => ProcessOut;
};

export function useAesModesWasm(): AesApi {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const modRef = useRef<WasmModule | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const wasm = (await import('../../wasm/aes-modes/aes_modes_practice.js')) as unknown as WasmModule;
        await wasm.default();
        if (!cancelled) {
          modRef.current = wasm;
          setStatus('ready');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    status,
    error,
    randomHex(n) {
      if (!modRef.current) throw new Error('WASM not loaded');
      return modRef.current.random_hex(n);
    },
    deriveKey(passphrase, salt, iters, outLen) {
      if (!modRef.current) throw new Error('WASM not loaded');
      return modRef.current.derive_key(passphrase, salt, iters, outLen);
    },
    process(direction, mode, key, iv, data) {
      if (!modRef.current) throw new Error('WASM not loaded');
      return modRef.current.process(direction, mode, key, iv, data);
    },
    processImage(direction, mode, key, iv, data) {
      if (!modRef.current) throw new Error('WASM not loaded');
      return modRef.current.process_image(direction, mode, key, iv, data);
    },
  };
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/[\s:]/g, '');
  if (!/^[0-9a-f]*$/.test(clean)) throw new Error('Hex contains invalid characters');
  if (clean.length % 2 !== 0) throw new Error('Hex must have an even number of characters');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
