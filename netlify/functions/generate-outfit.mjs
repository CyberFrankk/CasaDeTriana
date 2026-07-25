import { getStore } from '@netlify/blobs';

// ===== Configuración =====
const DAILY_LIMIT = 10;
const MODEL = 'gemini-2.5-flash-image';
const PROMPT = 'Usa la primera imagen como referencia de mi cuerpo. Usa la segunda imagen como referencia del outfit y coloca esa ropa sobre mi cuerpo de forma realista. El objetivo es generar una prueba del outfit sobre mi cuerpo.';

export default async (req) => {
  // Solo aceptamos POST
  if (req.method !== 'POST') {
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  // ===== 1. Revisar el límite diario ANTES de gastar nada =====
  const store = getStore('outfit-limits');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `count-${today}`;

  let count = 0;
  try {
    const raw = await store.get(key);
    count = raw ? parseInt(raw, 10) : 0;
  } catch (e) {
    count = 0;
  }

  if (count >= DAILY_LIMIT) {
    return json({
      error: 'LIMIT_REACHED',
      message: `Ya generaste ${DAILY_LIMIT} outfits hoy. Vuelve mañana para generar más 💛`,
      remaining: 0,
      limit: DAILY_LIMIT
    }, 429);
  }

  // ===== 2. Leer las imágenes que mandó el navegador =====
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: 'BAD_REQUEST', message: 'No se pudo leer la petición' }, 400);
  }

  const { characterImage, garmentImage } = body || {};
  if (!characterImage || !garmentImage) {
    return json({ error: 'MISSING_IMAGES', message: 'Faltan imágenes' }, 400);
  }

  // ===== 3. Llamar a la API de Gemini =====
  const apiKey = Netlify.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return json({ error: 'NO_API_KEY', message: 'Falta configurar GEMINI_API_KEY en Netlify' }, 500);
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  let geminiRes, data;
  try {
    geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: 'image/png', data: characterImage } },
            { inline_data: { mime_type: 'image/png', data: garmentImage } }
          ]
        }]
      })
    });
    data = await geminiRes.json();
  } catch (e) {
    return json({ error: 'NETWORK_ERROR', message: 'No se pudo contactar a Gemini' }, 502);
  }

  if (!geminiRes.ok) {
    return json({ error: 'GEMINI_ERROR', message: data?.error?.message || 'Error de Gemini', detail: data }, 502);
  }

  // ===== 4. Extraer la imagen generada de la respuesta =====
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData || p.inline_data);
  const imageB64 = imagePart?.inlineData?.data || imagePart?.inline_data?.data;

  if (!imageB64) {
    return json({ error: 'NO_IMAGE_RETURNED', message: 'Gemini no devolvió una imagen', detail: data }, 502);
  }

  // ===== 5. Solo AHORA que sí funcionó, sumamos al contador =====
  const newCount = count + 1;
  try {
    await store.set(key, String(newCount));
  } catch (e) {
    // si falla el guardado del contador no bloqueamos al usuario, solo seguimos
  }

  return json({
    image: imageB64,
    remaining: DAILY_LIMIT - newCount,
    limit: DAILY_LIMIT
  }, 200);
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const config = { path: '/api/generate-outfit' };
