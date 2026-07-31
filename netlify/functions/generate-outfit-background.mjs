import { Client } from '@gradio/client';
import { getStore } from '@netlify/blobs';

// ===== Configuración =====
const DAILY_LIMIT = 10;
const VTON_SPACE = 'yisol/IDM-VTON';
const RMBG_SPACE = 'briaai/BRIA-RMBG-2.0';

// Esta función corre "en segundo plano" (hasta 15 min), por eso el nombre
// del archivo termina en "-background" — Netlify la detecta automática.
export default async (req) => {
  const jobStore = getStore('outfit-jobs');

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return; // no hay a quién responderle en una background function
  }

  const { jobId, characterImage, topImage, bottomImage, topDesc, bottomDesc } = body || {};
  if (!jobId) return;

  const limitStore = getStore('outfit-limits');
  const today = new Date().toISOString().slice(0, 10);
  const limitKey = `count-${today}`;

  try {
    let count = 0;
    try {
      const raw = await limitStore.get(limitKey);
      count = raw ? parseInt(raw, 10) : 0;
    } catch (e) { /* ignore */ }

    if (count >= DAILY_LIMIT) {
      await setJob(jobStore, jobId, { status: 'error', message: `Ya generaste ${DAILY_LIMIT} outfits hoy. Vuelve mañana para generar más 💛` });
      return;
    }

    if (!characterImage || !topImage) {
      await setJob(jobStore, jobId, { status: 'error', message: 'Faltan la imagen del personaje y/o la prenda de arriba' });
      return;
    }

    const hfToken = Netlify.env.get('HF_TOKEN');
    const clientOpts = hfToken ? { hf_token: hfToken } : undefined;

    await setJob(jobStore, jobId, { status: 'processing', step: 'Poniendo la prenda de arriba...' });
    let current = await withTimeout(
      runTryOn(characterImage, topImage, topDesc || 'prenda superior', clientOpts),
      240000, 'TOP_TIMEOUT'
    );

    let bottomApplied = true;
    if (bottomImage) {
      await setJob(jobStore, jobId, { status: 'processing', step: 'Poniendo la prenda de abajo...' });
      try {
        current = await withTimeout(
          runTryOn(current, bottomImage, bottomDesc || 'prenda inferior', clientOpts),
          240000, 'BOTTOM_TIMEOUT'
        );
      } catch (e) {
        bottomApplied = false;
      }
    }

    await setJob(jobStore, jobId, { status: 'processing', step: 'Quitando el fondo...' });
    let finalImage = current;
    let bgRemoved = true;
    try {
      finalImage = await withTimeout(removeBackground(current, clientOpts), 90000, 'RMBG_TIMEOUT');
    } catch (e) {
      // Si quitar el fondo falla o se cuelga, no perdemos todo el trabajo:
      // entregamos el resultado vestido tal cual, con fondo.
      finalImage = current;
      bgRemoved = false;
    }

    const newCount = count + 1;
    try { await limitStore.set(limitKey, String(newCount)); } catch (e) { /* ignore */ }

    await setJob(jobStore, jobId, {
      status: 'done',
      image: finalImage,
      bgRemoved,
      bottomApplied,
      remaining: DAILY_LIMIT - newCount,
      limit: DAILY_LIMIT
    });

  } catch (e) {
    await setJob(jobStore, jobId, { status: 'error', message: e?.message || 'Error generando el outfit' });
  }
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || 'TIMEOUT')), ms))
  ]);
}

async function setJob(store, jobId, data) {
  try { await store.set(jobId, JSON.stringify(data)); } catch (e) { /* ignore */ }
}

// ===== Llama a IDM-VTON: pone `garmentB64` sobre `personB64` =====
async function runTryOn(personB64, garmentB64, description, clientOpts) {
  const client = await Client.connect(VTON_SPACE, clientOpts);
  const personBlob = base64ToBlob(personB64, 'image/jpeg');
  const garmentBlob = base64ToBlob(garmentB64, 'image/jpeg');

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
