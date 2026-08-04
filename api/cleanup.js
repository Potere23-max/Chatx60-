import { list, del } from '@vercel/blob';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Non autorizzato' });
    return;
  }

  try {
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
    res.status(200).json({ deleted: expired.length, checked: blobs.length });
  } catch (err) {
    console.error('Errore pulizia cron:', err);
    res.status(500).json({ error: 'Errore nella pulizia' });
  }
}
