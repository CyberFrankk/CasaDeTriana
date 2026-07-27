import { Client } from '@gradio/client';
import { getStore } from '@netlify/blobs';

// ===== Configuración =====
const DAILY_LIMIT = 10;
const VTON_SPACE = 'yisol/IDM-VTON';
const RMBG_SPACE = 'briaai/BRIA-RMBG-2.0';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  // ===== 1. Revisar el límite diario ANTES de gastar nada =====
  const store = getStore('outfit-limits');
  const today = new Date().toISOString().slice(0, 10);
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

  const { characterImage, topImage, bottomImage, topDesc, bottomDesc } = body || {};
  if (!characterImage || !topImage) {
    return json({ error: 'MISSING_IMAGES', message: 'Faltan la imagen del personaje y/o la prenda de arriba' }, 400);
  }

  const hfToken = Netlify.env.get('HF_TOKEN');
  const clientOpts = hfToken ? { hf_token: hfToken } : undefined;

  try {
    // ===== 3. Paso 1: poner la prenda de ARRIBA =====
    let currentImageB64 = characterImage;
    currentImageB64 = await runTryOn(currentImageB64, topImage, topDesc || 'prenda superior', clientOpts);

    // ===== 4. Paso 2: si hay prenda de ABAJO, encadenar sobre el resultado anterior =====
    if (bottomImage) {
      currentImageB64 = await runTryOn(currentImageB64, bottomImage, bottomDesc || 'prenda inferior', clientOpts);
    }

    // ===== 5. Paso 3: quitar el fondo, dejar PNG transparente =====
    const finalImageB64 = await removeBackground(currentImageB64, clientOpts);

    // ===== 6. Solo AHORA que sí funcionó, sumamos al contador =====
    const newCount = count + 1;
    try {
      await store.set(key, String(newCount));
    } catch (e) { /* no bloqueamos por esto */ }

    return json({
      image: finalImageB64,
      remaining: DAILY_LIMIT - newCount,
      limit: DAILY_LIMIT
    }, 200);

  } catch (e) {
    return json({ error: 'PIPELINE_ERROR', message: e?.message || 'Error generando el outfit' }, 502);
  }
};

// ===== Llama a IDM-VTON: pone `garmentB64` sobre `personB64` =====
async function runTryOn(personB64, garmentB64, description, clientOpts) {
  const client = await Client.connect(VTON_SPACE, clientOpts);
  const personBlob = base64ToBlob(personB64, 'image/png');
  const garmentBlob = base64ToBlob(garmentB64, 'image/png');

  const result = await client.predict('/tryon', {
    dict: { background: personBlob, layers: [], composite: null },
    garm_img: garmentBlob,
    garment_des: description,
    is_checked: true,
    is_checked_crop: false,
    denoise_steps: 30,
    seed: 42
  });

  const outputEntry = result?.data?.[0];
  const outputUrl = outputEntry?.url || outputEntry?.path;
  if (!outputUrl) throw new Error('El modelo de prueba de ropa no devolvió imagen');

  return await urlToBase64(outputUrl);
}

// ===== Llama a RMBG-2.0: quita el fondo de `imageB64` =====
async function removeBackground(imageB64, clientOpts) {
  const client = await Client.connect(RMBG_SPACE, clientOpts);
  const imgBlob = base64ToBlob(imageB64, 'image/png');

  const result = await client.predict('/predict', { image: imgBlob });

  const outputEntry = Array.isArray(result?.data) ? result.data[0] : result?.data;
  const outputUrl = outputEntry?.url || outputEntry?.path;
  if (!outputUrl) throw new Error('El modelo de fondo no devolvió imagen');

  return await urlToBase64(outputUrl);
}

async function urlToBase64(url) {
  const res = await fetch(url);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf).toString('base64');
}

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
