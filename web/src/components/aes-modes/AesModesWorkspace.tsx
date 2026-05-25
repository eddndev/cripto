import { Fragment, useEffect, useMemo, useState } from 'react';
import { hexToBytes, useAesModesWasm, type BlockTrace, type ProcessOut } from './useAesModesWasm';

type Lang = 'en' | 'es';
type Direction = 'encrypt' | 'decrypt';
type Mode = 'ECB' | 'CBC' | 'CFB' | 'OFB' | 'CTR';
type KeySource = 'hex' | 'passphrase';

const MODES: Mode[] = ['ECB', 'CBC', 'CFB', 'OFB', 'CTR'];

const T = {
  en: {
    loading: 'Loading WebAssembly…',
    wasmError: 'Failed to load WASM',
    direction: 'Direction',
    encrypt: 'Encrypt',
    decrypt: 'Decrypt',
    mode: 'Mode',
    keyHeader: 'Key (AES-128 → 16 bytes / 32 hex chars)',
    keySource: 'Key source',
    keyHex: 'Hex',
    keyPass: 'Passphrase (PBKDF2)',
    keyHexLabel: 'Key (32 hex chars)',
    passphrase: 'Passphrase',
    salt: 'Salt (hex)',
    iters: 'Iterations',
    derived: 'Derived key',
    derive: 'Derive',
    iv: 'IV / Nonce (32 hex chars)',
    ivNotUsed: 'ECB does not use an IV.',
    randomize: 'Random',
    fileLabel: 'Input file',
    pickFile: 'Pick a file…',
    chosen: 'Selected',
    imageMode: 'Preserve image container (BMP)',
    imageHint: 'Encrypts only the pixel body — the BMP header stays intact so the result still renders as an image (the classic "ECB penguin" demo). Other image formats (PNG, JPG, WebP…) are auto-converted to BMP on upload so the demo works on any image.',
    imageInfo: 'Image',
    converted: 'Auto-converted to BMP',
    converting: 'Converting to BMP…',
    previewIn: 'Original',
    previewOut: 'Processed',
    run: 'Run',
    running: 'Working…',
    download: 'Download result',
    statsBlocks: 'Blocks processed',
    statsPad: 'Padding',
    traceTitle: 'Per-block trace',
    traceHidden: '(showing first 10 + last 2 — full trace omitted to keep the page light)',
    cols: {
      i: '#',
      input: 'Input',
      aesIn: 'AES input',
      aesOut: 'AES output',
      xor: 'XOR with',
      output: 'Output',
      counter: 'Counter',
    },
    ellipsis: '…',
  },
  es: {
    loading: 'Cargando WebAssembly…',
    wasmError: 'Error al cargar WASM',
    direction: 'Dirección',
    encrypt: 'Cifrar',
    decrypt: 'Descifrar',
    mode: 'Modo',
    keyHeader: 'Llave (AES-128 → 16 bytes / 32 chars hex)',
    keySource: 'Origen de la llave',
    keyHex: 'Hex',
    keyPass: 'Frase (PBKDF2)',
    keyHexLabel: 'Llave (32 chars hex)',
    passphrase: 'Frase',
    salt: 'Sal (hex)',
    iters: 'Iteraciones',
    derived: 'Llave derivada',
    derive: 'Derivar',
    iv: 'IV / Nonce (32 chars hex)',
    ivNotUsed: 'ECB no usa IV.',
    randomize: 'Aleatorio',
    fileLabel: 'Archivo de entrada',
    pickFile: 'Elegir archivo…',
    chosen: 'Seleccionado',
    imageMode: 'Preservar contenedor de imagen (BMP)',
    imageHint: 'Cifra solo el cuerpo de píxeles — el header BMP queda intacto, así el resultado se sigue viendo como imagen (el clásico demo del "pingüino ECB"). Otros formatos (PNG, JPG, WebP…) se auto-convierten a BMP al subirlos para que la demo funcione con cualquier imagen.',
    imageInfo: 'Imagen',
    converted: 'Convertido automáticamente a BMP',
    converting: 'Convirtiendo a BMP…',
    previewIn: 'Original',
    previewOut: 'Resultado',
    run: 'Ejecutar',
    running: 'Procesando…',
    download: 'Descargar resultado',
    statsBlocks: 'Bloques procesados',
    statsPad: 'Padding',
    traceTitle: 'Traza por bloque',
    traceHidden: '(mostrando los primeros 10 + últimos 2 — traza completa omitida para mantener ligera la página)',
    cols: {
      i: '#',
      input: 'Entrada',
      aesIn: 'Entrada AES',
      aesOut: 'Salida AES',
      xor: 'XOR con',
      output: 'Salida',
      counter: 'Contador',
    },
    ellipsis: '…',
  },
} as const;

/** Encode an ImageData (RGBA, top-down) as a 24-bit BMP file. */
function imageDataToBmp(img: ImageData): Uint8Array {
  const { width, height, data } = img;
  const rowSize = ((24 * width + 31) >> 5) * 4; // padded to 4 bytes
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const bmp = new Uint8Array(fileSize);
  const view = new DataView(bmp.buffer);
  // BITMAPFILEHEADER
  bmp[0] = 0x42; bmp[1] = 0x4d; // 'BM'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, 54, true); // bfOffBits
  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true); // negative height → top-down
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, pixelDataSize, true);
  // pixels: BGR, top-down (matches negative height)
  for (let y = 0; y < height; y++) {
    const rowOffset = 54 + y * rowSize;
    const srcRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = rowOffset + x * 3;
      bmp[d] = data[s + 2];
      bmp[d + 1] = data[s + 1];
      bmp[d + 2] = data[s];
    }
  }
  return bmp;
}

async function isBmpByMagic(file: File): Promise<boolean> {
  if (file.size < 2) return false;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x42 && head[1] === 0x4d; // 'BM'
}

async function convertToBmp(file: File): Promise<File> {
  if (await isBmpByMagic(file)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Failed to decode image'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bmp = imageDataToBmp(data);
    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([bmp], `${base}.bmp`, { type: 'image/bmp' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isImageFile(f: File): boolean {
  if (f.type.startsWith('image/')) return true;
  return /\.(bmp|png|jpe?g|gif|webp|avif|tiff?)$/i.test(f.name);
}

function download(filename: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AesModesWorkspace({ lang = 'en' as Lang }: { lang?: Lang }) {
  const t = T[lang];
  const wasm = useAesModesWasm();
  const ready = wasm.status === 'ready';

  const [direction, setDirection] = useState<Direction>('encrypt');
  const [mode, setMode] = useState<Mode>('CBC');
  const [keySource, setKeySource] = useState<KeySource>('hex');
  const [keyHex, setKeyHex] = useState('');
  const [pass, setPass] = useState('');
  const [salt, setSalt] = useState('');
  const [iters, setIters] = useState(100_000);
  const [derivedKey, setDerivedKey] = useState('');
  const [ivHex, setIvHex] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [imageMode, setImageMode] = useState(false);
  const [converting, setConverting] = useState(false);
  const [wasConverted, setWasConverted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessOut | null>(null);

  const effectiveKey = keySource === 'hex' ? keyHex : derivedKey;
  const ivUsed = mode !== 'ECB';

  function randHex(n: number, set: (v: string) => void) {
    try {
      set(wasm.randomHex(n));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function derive() {
    setError(null);
    try {
      const saltBytes = salt.trim() ? hexToBytes(salt) : new Uint8Array();
      const k = wasm.deriveKey(pass, saltBytes, iters, 16);
      setDerivedKey(k);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function run() {
    setError(null);
    setResult(null);
    if (!ready) {
      setError('WASM not loaded');
      return;
    }
    if (!file) {
      setError(lang === 'es' ? 'Selecciona un archivo.' : 'Pick a file.');
      return;
    }
    setBusy(true);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      const keyBytes = hexToBytes(effectiveKey);
      if (keyBytes.length !== 16) throw new Error(`Key must be exactly 16 bytes (got ${keyBytes.length})`);
      const ivBytes = ivUsed ? hexToBytes(ivHex) : new Uint8Array();
      if (ivUsed && ivBytes.length !== 16) {
        throw new Error(`${mode} requires a 16-byte IV (got ${ivBytes.length})`);
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const out = imageMode
        ? wasm.processImage(direction, mode, keyBytes, ivBytes, data)
        : wasm.process(direction, mode, keyBytes, ivBytes, data);
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const outName = useMemo(() => {
    if (!file) return 'output.bin';
    const tag = direction === 'encrypt' ? `_e${mode}` : `_d${mode}`;
    const name = file.name;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}${tag}`;
    return `${name.slice(0, dot)}${tag}${name.slice(dot)}`;
  }, [file, direction, mode]);

  return (
    <div className="flex flex-col gap-6">
      {wasm.status === 'loading' && (
        <div className="font-mono text-[0.78rem] text-text-secondary">{t.loading}</div>
      )}
      {wasm.status === 'error' && (
        <div className="p-4 border border-red-500/50 bg-red-500/10 font-mono text-[0.85rem] text-red-400">
          {t.wasmError}: {wasm.error}
        </div>
      )}

      <div className="grid grid-cols-2 max-md:grid-cols-1 gap-6">
        <Field label={t.direction}>
          <ButtonGroup
            options={[
              { value: 'encrypt', label: t.encrypt },
              { value: 'decrypt', label: t.decrypt },
            ]}
            value={direction}
            onChange={(v) => setDirection(v as Direction)}
          />
        </Field>
        <Field label={t.mode}>
          <ButtonGroup
            options={MODES.map((m) => ({ value: m, label: m }))}
            value={mode}
            onChange={(v) => setMode(v as Mode)}
          />
        </Field>
      </div>

      <Section title={t.keyHeader}>
        <ButtonGroup
          options={[
            { value: 'hex', label: t.keyHex },
            { value: 'passphrase', label: t.keyPass },
          ]}
          value={keySource}
          onChange={(v) => setKeySource(v as KeySource)}
        />
        {keySource === 'hex' ? (
          <div className="flex gap-2 flex-wrap items-end">
            <Field label={t.keyHexLabel} className="flex-1 min-w-[280px]">
              <input
                type="text"
                value={keyHex}
                spellCheck={false}
                onChange={(e) => setKeyHex(e.target.value)}
                placeholder="00112233445566778899aabbccddeeff"
                className="bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.85rem] text-text-primary focus:outline-none focus:border-accent transition-colors w-full"
              />
            </Field>
            <SmallBtn onClick={() => randHex(16, setKeyHex)} label={t.randomize} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 max-md:grid-cols-1 gap-3">
              <Field label={t.passphrase} className="col-span-1">
                <input
                  type="text"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  className="bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.85rem]"
                />
              </Field>
              <Field label={t.salt}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={salt}
                    spellCheck={false}
                    onChange={(e) => setSalt(e.target.value)}
                    placeholder="(optional, hex)"
                    className="bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.85rem] flex-1"
                  />
                  <SmallBtn onClick={() => randHex(16, setSalt)} label={t.randomize} />
                </div>
              </Field>
              <Field label={t.iters}>
                <input
                  type="number"
                  value={iters}
                  min={1}
                  onChange={(e) => setIters(parseInt(e.target.value || '1', 10))}
                  className="bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.85rem]"
                />
              </Field>
            </div>
            <div className="flex items-end gap-2 flex-wrap">
              <SmallBtn onClick={derive} label={t.derive} />
              <span className="font-mono text-[0.78rem] text-text-secondary">
                {t.derived}: <span className="text-accent break-all">{derivedKey || '—'}</span>
              </span>
            </div>
          </div>
        )}
      </Section>

      <Section title={t.iv}>
        {ivUsed ? (
          <div className="flex gap-2 flex-wrap items-end">
            <input
              type="text"
              value={ivHex}
              spellCheck={false}
              onChange={(e) => setIvHex(e.target.value)}
              placeholder="000102030405060708090a0b0c0d0e0f"
              className="bg-[#0c0c12] border border-[#3a3a42] p-3 font-mono text-[0.85rem] text-text-primary focus:outline-none focus:border-accent transition-colors flex-1 min-w-[280px]"
            />
            <SmallBtn onClick={() => randHex(16, setIvHex)} label={t.randomize} />
          </div>
        ) : (
          <div className="font-mono text-[0.78rem] text-text-secondary italic">{t.ivNotUsed}</div>
        )}
      </Section>

      <Section title={t.fileLabel}>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="cursor-pointer font-mono text-[0.78rem] uppercase tracking-[0.08em] py-2 px-4 border border-[#3a3a42] text-text-secondary hover:text-text-primary hover:border-accent transition-colors">
            {t.pickFile}
            <input
              type="file"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0] ?? null;
                setError(null);
                setResult(null);
                setWasConverted(false);
                if (!f) {
                  setFile(null);
                  return;
                }
                // Detect by magic bytes first — handles BMPs without .bmp extension.
                const looksLikeBmp = await isBmpByMagic(f);
                if (looksLikeBmp) {
                  setFile(f);
                  setImageMode(true);
                  return;
                }
                if (isImageFile(f)) {
                  setConverting(true);
                  try {
                    const bmp = await convertToBmp(f);
                    setFile(bmp);
                    setImageMode(true);
                    setWasConverted(true);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                    setFile(f);
                    setImageMode(false);
                  } finally {
                    setConverting(false);
                  }
                } else {
                  setFile(f);
                  setImageMode(false);
                }
              }}
            />
          </label>
          {converting && (
            <span className="font-mono text-[0.78rem] text-text-secondary">{t.converting}</span>
          )}
          {file && !converting && (
            <span className="font-mono text-[0.78rem] text-text-secondary">
              {t.chosen}: <span className="text-accent">{file.name}</span>{' '}
              <span>({file.size} B)</span>
              {wasConverted && (
                <span className="ml-2 text-[#a0a0aa]">— {t.converted}</span>
              )}
            </span>
          )}
        </div>
        <label className="flex items-start gap-2 cursor-pointer mt-1">
          <input
            type="checkbox"
            checked={imageMode}
            onChange={(e) => setImageMode(e.target.checked)}
            className="mt-1 accent-accent"
          />
          <span className="flex flex-col">
            <span className="font-mono text-[0.78rem] text-text-primary">{t.imageMode}</span>
            <span className="font-mono text-[0.7rem] text-text-secondary leading-relaxed">{t.imageHint}</span>
          </span>
        </label>
      </Section>

      <button
        type="button"
        onClick={run}
        disabled={busy || !ready || !file}
        className="self-start font-mono text-[0.8rem] font-semibold tracking-[0.1em] uppercase py-3 px-6 bg-accent-deep text-white border-none cursor-pointer transition-all duration-200 hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {busy ? t.running : `${t.run} — ${direction === 'encrypt' ? t.encrypt : t.decrypt} ${mode}`}
      </button>

      {error && (
        <div className="p-3 border border-red-500/50 bg-red-500/10 font-mono text-[0.85rem] text-red-400">
          {error}
        </div>
      )}

      {result && (
        <ResultPanel
          result={result}
          t={t}
          onDownload={() => download(outName, result.ciphertext)}
          outName={outName}
          mode={mode}
          originalFile={file}
        />
      )}
    </div>
  );
}

function useObjectUrl(data: Uint8Array | null, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(new Blob([data], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, mime]);
  return url;
}

function useFileUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function ResultPanel({
  result,
  t,
  onDownload,
  outName,
  mode,
  originalFile,
}: {
  result: ProcessOut;
  t: (typeof T)['en'];
  onDownload: () => void;
  outName: string;
  mode: Mode;
  originalFile: File | null;
}) {
  const isBmp = result.image_info != null;
  const inUrl = useFileUrl(isBmp ? originalFile : null);
  const outUrl = useObjectUrl(isBmp ? result.ciphertext : null, 'image/bmp');
  return (
    <div className="flex flex-col gap-4 border border-[#3a3a42] bg-[#0c0c12] p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[0.72rem] text-accent uppercase tracking-[0.08em]">{outName}</span>
          <span className="font-mono text-[0.7rem] text-text-secondary">
            {result.ciphertext.byteLength} B • {result.blocks_total} {t.statsBlocks.toLowerCase()}
          </span>
        </div>
        <button
          type="button"
          onClick={onDownload}
          className="font-mono text-[0.78rem] uppercase tracking-[0.08em] py-2 px-4 border border-[#3a3a42] hover:border-accent hover:text-accent text-text-secondary transition-colors"
        >
          {t.download}
        </button>
      </div>
      {result.pad_info && (
        <div className="font-mono text-[0.78rem] text-text-secondary">
          {t.statsPad}: <span className="text-text-primary">{result.pad_info}</span>
        </div>
      )}
      {result.image_info && (
        <div className="font-mono text-[0.78rem] text-text-secondary">
          {t.imageInfo}: <span className="text-text-primary">{result.image_info}</span>
        </div>
      )}
      {isBmp && inUrl && outUrl && (
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-3">
          <PreviewCard label={t.previewIn} url={inUrl} />
          <PreviewCard label={t.previewOut} url={outUrl} />
        </div>
      )}
      <div>
        <h4 className="font-mono text-[0.78rem] uppercase tracking-[0.08em] text-text-secondary mb-2">
          {t.traceTitle}
        </h4>
        {result.truncated && (
          <p className="font-mono text-[0.7rem] text-text-secondary italic mb-2">{t.traceHidden}</p>
        )}
        <TraceTable trace={result.trace} mode={mode} t={t} truncated={result.truncated} />
      </div>
    </div>
  );
}

function TraceTable({
  trace,
  mode,
  t,
  truncated,
}: {
  trace: BlockTrace[];
  mode: Mode;
  t: (typeof T)['en'];
  truncated: boolean;
}) {
  const showCounter = mode === 'CTR';
  const showXor = mode !== 'ECB';
  // For OFB/CFB/CTR/CBC the input is the per-block input (pt or ct); xor_with is keystream / IV chain.
  return (
    <div className="overflow-x-auto border border-[#2a2a32]">
      <table className="w-full font-mono text-[0.7rem]">
        <thead>
          <tr className="bg-[#1a1a22] text-text-secondary text-left">
            <Th>{t.cols.i}</Th>
            <Th>{t.cols.input}</Th>
            {showXor && <Th>{t.cols.xor}</Th>}
            <Th>{t.cols.aesIn}</Th>
            <Th>{t.cols.aesOut}</Th>
            {showCounter && <Th>{t.cols.counter}</Th>}
            <Th>{t.cols.output}</Th>
          </tr>
        </thead>
        <tbody>
          {trace.map((b, idx) => {
            const isSplitBoundary = truncated && idx === trace.length - 2;
            return (
              <Fragment key={b.index}>
                {isSplitBoundary && (
                  <tr className="bg-[#0c0c12]">
                    <td colSpan={8} className="px-3 py-1 text-center text-text-secondary">
                      {t.ellipsis}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-[#2a2a32]">
                  <Td>{b.index}</Td>
                  <Td mono>{b.input}</Td>
                  {showXor && <Td mono>{b.xor_with}</Td>}
                  <Td mono>{b.aes_in}</Td>
                  <Td mono>{b.aes_out}</Td>
                  {showCounter && <Td mono>{b.counter}</Td>}
                  <Td mono accent>{b.output}</Td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PreviewCard({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex flex-col gap-2 border border-[#2a2a32] bg-[#0c0c12] p-3">
      <span className="font-mono text-[0.7rem] text-text-secondary uppercase tracking-[0.08em]">{label}</span>
      <img
        src={url}
        alt={label}
        className="w-full max-h-[320px] object-contain bg-[#000] image-render-pixelated"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[0.65rem]">{children}</th>;
}

function Td({
  children,
  mono,
  accent,
}: {
  children: React.ReactNode;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <td
      className={`px-3 py-1.5 align-top ${mono ? 'whitespace-nowrap' : ''} ${
        accent ? 'text-accent' : 'text-text-primary'
      }`}
    >
      {children}
    </td>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-mono text-[0.78rem] uppercase tracking-[0.08em] text-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <span className="font-mono text-[0.7rem] text-text-secondary uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}

function ButtonGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`font-mono text-[0.75rem] uppercase tracking-[0.08em] py-2 px-3 border transition-colors ${
            value === o.value
              ? 'border-accent bg-accent-deep text-white'
              : 'border-[#3a3a42] text-text-secondary hover:text-text-primary hover:border-accent'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SmallBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[0.72rem] uppercase tracking-[0.08em] py-2 px-3 border border-[#3a3a42] text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
    >
      {label}
    </button>
  );
}
