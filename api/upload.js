import { put, list, del } from '@vercel/blob';

const TTL_MS = 12 * 60 * 60 * 1000; // le foto scadono dopo 12 ore

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo non consentito' });
    return;
  }

  try {
    const { imageBase64, roomId } = req.body || {};
    if (!imageBase64) {
      res.status(400).json({ error: 'Immagine mancante' });
      return;
    }

    // Pulizia opportunistica: ogni nuovo caricamento è anche l'occasione
    // per eliminare le foto di qualunque stanza che sono già scadute.
    await cleanupExpiredBlobs();

    const expiresAt = Date.now() + TTL_MS;
    const safeRoom = String(roomId || 'chat').replace(/[^a-zA-Z0-9-_]/g, '') || 'chat';
    const filename = `foto/${safeRoom}-${expiresAt}-${Math.random().toString(36).slice(2)}.jpg`;

    const base64Data = imageBase64.split(',').pop();
    const buffer = Buffer.from(base64Data, 'base64');

    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: 'image/jpeg',
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('Errore upload foto:', err);
    res.status(500).json({ error: 'Errore nel caricamento della foto' });
  }
}

async function cleanupExpiredBlobs() {
  const now = Date.now();
  const { blobs } = await list({ prefix: 'foto/' });
  const expired = blobs.filter((b) => {
    const match = b.pathname.match(/-(\d+)-/);
    if (!match) return false;
    return now > parseInt(match[1], 10);
  });
  if (expired.length > 0) {
    await del(expired.map((b) => b.url));
  }
}
