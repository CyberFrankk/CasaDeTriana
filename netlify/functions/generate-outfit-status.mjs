import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const jobId = url.searchParams.get('jobId');

  if (!jobId) {
    return json({ status: 'error', message: 'Falta jobId' }, 400);
  }

  const jobStore = getStore('outfit-jobs');

  try {
    const raw = await jobStore.get(jobId);
    if (!raw) {
      // todavía no hay nada guardado, la función de fondo apenas está arrancando
      return json({ status: 'processing', step: 'Iniciando...' }, 200);
    }
    const data = JSON.parse(raw);
    return json(data, 200);
  } catch (e) {
    return json({ status: 'processing', step: 'Iniciando...' }, 200);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const config = { path: '/api/generate-outfit-status' };
