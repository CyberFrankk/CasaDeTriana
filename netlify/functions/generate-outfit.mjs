import { Client } from '@gradio/client';
import { getStore } from '@netlify/blobs';

// ===== Configuración =====
const DAILY_LIMIT = 10;
// Puedes cambiar esto a otra copia del espacio si el original está muy saturado,
// por ejemplo: 'freddyaboulton/IDM-VTON' o 'jallenjia/Change-Clothes-AI'
const SPACE = 'yisol/IDM-VTON';

export default async (req) => {
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

  const { characterImage, garmentImage, garmentDesc } = body || {};
  if (!characterImage || !garmentImage) {
    return json({ error: 'MISSING_IMAGES', message: 'Faltan imágenes' }, 400);
  }

  // ===== 3. Llamar al modelo IDM-VTON en Hugging Face Spaces =====
  const hfToken = Netlify.env.get('HF_TOKEN'); // opcional, pero recomendado (gratis) para mejor cuota

  let result;
  try {
    const client = await Client.connect(SPACE, hfToken ? { hf_token: hfToken } : undefined);

    const personBlob = base64ToBlob(characterImage, 'image/png');
    const garmentBlob = base64ToBlob(garmentImage, 'image/png');

    result = await client.predict('/tryon', {
      dict: { background: personBlob, layers: [], composite: null },
      garm_img: garmentBlob,
      garment_des: garmentDesc || 'prenda de ropa',
      is_checked: true,
      is_checked_crop: false,
      denoise_steps: 30,
      seed: 42
    });
  } catch (e) {
    return json({ error: 'VTON_ERROR', message: e?.message || 'Error contactando el modelo de prueba de ropa' }, 502);
  }

  // ===== 4. Extraer la imagen resultante =====
  const outputEntry = result?.data?.[0];
  const outputUrl = outputEntry?.url || outputEntry?.path;

  if (!outputUrl) {
    return json({ error: 'NO_IMAGE_RETURNED', message: 'El modelo no devolvió una imagen', detail: result }, 502);
  }

  let imageB64;
  try {
    const imgRes = await fetch(outputUrl);
    const arrayBuf = await imgRes.arrayBuffer();
    imageB64 = Buffer.from(arrayBuf).toString('base64');
  } catch (e) {
    return json({ error: 'DOWNLOAD_ERROR', message: 'No se pudo descargar la imagen generada' }, 502);
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

function base64ToBlob(b64, mime) {
  const buffer = Buffer.from(b64, 'base64');
  return new Blob([buffer], { type: mime });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const config = { path: '/api/generate-outfit' };
