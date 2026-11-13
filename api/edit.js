// Vercel Serverless Function - proxy ke Photoroom API
// API key disimpan di Environment Variable: PHOTOROOM_API_KEY

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

const HEX = /^#?[0-9a-fA-F]{6}$/;
const FORMATS = ['png', 'jpg', 'webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const apiKey = process.env.PHOTOROOM_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'PHOTOROOM_API_KEY belum diset di Environment Variables Vercel' });
  }

  try {
    const { image, mode, options = {} } = req.body || {};

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
    const headers = { 'x-api-key': apiKey, Accept: 'image/*, application/json' };
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

    const upstream = await fetch(url, { method: 'POST', headers, body: form });

    if (!upstream.ok) {
      const text = await upstream.text();
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.detail || j.message || j.error?.message || j.error || text;
      } catch (_) {}
      return res
        .status(upstream.status)
        .json({ error: `Photoroom (${upstream.status}): ${String(msg).slice(0, 300)}` });
    }

    const type = upstream.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(200).json({ image: `data:${type};base64,${buf.toString('base64')}` });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || err) });
  }
}
