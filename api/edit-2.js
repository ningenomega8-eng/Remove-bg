// Vercel Serverless Function - proxy ke Photoroom API
// API key disimpan di Environment Variable: PHOTOROOM_API_KEY

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

const HEX = /^#?[0-9a-fA-F]{6}$/;
const FORMATS = ['png', 'jpg', 'webp'];

// Rotasi API key.
// Isi PHOTOROOM_API_KEYS dengan beberapa key dipisah koma atau baris baru.
// Key dipakai berurutan; kalau habis kredit / ditolak, otomatis pindah ke key berikutnya.
// Status yang memicu pindah key, dan lama key itu dilewati:
const SKIP_MS = { 401: 6 * 3600e3, 402: 6 * 3600e3, 403: 6 * 3600e3, 429: 60e3 };
const dead = new Map(); // key -> waktu boleh dicoba lagi

function getKeys() {
  const raw = [process.env.PHOTOROOM_API_KEYS, process.env.PHOTOROOM_API_KEY]
    .filter(Boolean)
    .join(',');
  const list = [...new Set(raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
  // Key sandbox (gratis, hasil ber-watermark) dipisah dari key utama.
  // Pengguna memilih sendiri lewat opsi di web; tidak ada pindah otomatis.
  const isSandbox = (k) => k.startsWith('sandbox_');
  return { live: list.filter((k) => !isSandbox(k)), sandbox: list.filter(isSandbox) };
}

async function readError(r) {
  const text = await r.text();
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.detail || j.message || j.error?.message || j.error || text;
  } catch (_) {}
  return `Photoroom (${r.status}): ${String(msg).slice(0, 300)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const allKeys = getKeys();
  if (!allKeys.live.length && !allKeys.sandbox.length) {
    return res
      .status(500)
      .json({ error: 'PHOTOROOM_API_KEYS belum diset di Environment Variables Vercel' });
  }

  try {
    const { image, mode, options = {} } = req.body || {};

    // Pilih kumpulan key sesuai opsi di web (biasa / uji coba)
    const keys = options.sandbox ? allKeys.sandbox : allKeys.live;
    if (!keys.length) {
      return res.status(500).json({
        error: options.sandbox
          ? 'Key uji coba belum diisi di server.'
          : 'Key utama belum diisi di server.',
      });
    }

    if (typeof image !== 'string') {
      return res.status(400).json({ error: 'Gambar tidak ditemukan' });
    }
    const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'Format gambar tidak valid' });
    }

    const blob = new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
    const format = FORMATS.includes(options.format) ? options.format : 'png';
    const form = new FormData();
    const headers = { Accept: 'image/*, application/json' };
    let url;

    if (mode === 'remove') {
      // Remove Background API (Basic plan)
      url = 'https://sdk.photoroom.com/v1/segment';
      form.append('image_file', blob, 'image.jpg');
      form.append('format', format);
      if (options.crop) form.append('crop', 'true');
      if (typeof options.bgColor === 'string' && HEX.test(options.bgColor)) {
        form.append('bg_color', options.bgColor.replace('#', ''));
      }
    } else if (mode === 'edit') {
      // Image Editing API (Plus plan)
      url = 'https://image-api.photoroom.com/v2/edit';
      form.append('imageFile', blob, 'image.jpg');
      form.append('export.format', format);

      if (options.bgType === 'color' && HEX.test(options.bgColor || '')) {
        form.append('background.color', options.bgColor.replace('#', ''));
      } else if (options.bgType === 'ai' && typeof options.bgPrompt === 'string' && options.bgPrompt.trim()) {
        form.append('background.prompt', options.bgPrompt.trim().slice(0, 500));
      } else if (options.bgType === 'transparent') {
        form.append('background.color', 'transparent');
      }

      if (options.shadow) {
        form.append('shadow.mode', 'ai.preset-soft');
        headers['pr-ai-shadows-model-version'] = '2026-04-15';
      }
      if (options.relight) {
        form.append('lighting.mode', 'ai.preserve-hue-and-saturation');
      }
      const pad = Number(options.padding);
      if (pad > 0 && pad <= 0.4) form.append('padding', String(pad));
    } else {
      return res.status(400).json({ error: 'Mode tidak dikenal' });
    }

    // Pilih key yang belum "mati"; kalau semua sedang dilewati, coba lagi dari awal
    const now = Date.now();
    let live = keys.filter((k) => (dead.get(k) || 0) <= now);
    if (!live.length) live = keys;

    let upstream = null;
    let lastErr = '';
    for (const key of live) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'x-api-key': key },
        body: form,
      });
      if (r.ok) {
        upstream = r;
        break;
      }
      if (SKIP_MS[r.status]) {
        // Kredit habis / key ditolak / kena limit: tandai, lanjut ke key berikutnya
        dead.set(key, Date.now() + SKIP_MS[r.status]);
        lastErr = await readError(r);
        continue;
      }
      // Error lain (gambar tidak valid, dll): ganti key tidak membantu
      return res.status(r.status).json({ error: await readError(r) });
    }

    if (!upstream) {
      return res.status(503).json({
        error:
          `Semua key habis kredit atau ditolak.` +
          (options.sandbox ? '' : ' Coba pilih mode uji coba.') +
          ` Detail: ${lastErr}`,
      });
    }

    const type = upstream.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(200).json({ image: `data:${type};base64,${buf.toString('base64')}` });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || err) });
  }
}
