'use strict';
const GuardiansAI = require('../src/index.js');
const { GuardiansAIError } = GuardiansAI;

// Test 1: constructor exige apiKey
try {
  new GuardiansAI({});
  console.error('❌ debería haber fallado sin apiKey');
  process.exit(1);
} catch (e) {
  if (e instanceof GuardiansAIError) console.log('✅ constructor exige apiKey');
  else { console.error('❌ tipo de error incorrecto'); process.exit(1); }
}

// Test 2: constructor OK con apiKey
const client = new GuardiansAI({ apiKey: 'vfai_live_test123' });
console.log('✅ constructor OK con apiKey, baseUrl:', client.baseUrl);

// Test 3: analyze() exige file o text
client.analyze({}).then(() => {
  console.error('❌ debería haber fallado sin file/text');
  process.exit(1);
}).catch((e) => {
  if (e instanceof GuardiansAIError) console.log('✅ analyze() exige file o text');
  else { console.error('❌', e); process.exit(1); }

  // Test 4: mock de fetch para simular una respuesta real de /api/analyze
  global.fetch = async (url, opts) => {
    if (url.includes('/api/analyze') && opts.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          analysis_id: 'test-123',
          score: 87,
          verdict: 'ai_generated',
          confidence: 0.94,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  };

  return client.analyze({ text: 'hola mundo' }).then((result) => {
    if (result.analysis_id === 'test-123' && result.score === 87) {
      console.log('✅ analyze() con texto — parseo de respuesta OK');
    } else {
      console.error('❌ respuesta inesperada', result);
      process.exit(1);
    }
  });
}).then(() => {
  // Test 5: manejo de error HTTP (402 quota_exhausted)
  global.fetch = async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: 'quota_exhausted', message: 'Se agotaron tus análisis' }),
  });
  return client.analyze({ text: 'x' }).then(() => {
    console.error('❌ debería haber lanzado error 402');
    process.exit(1);
  }).catch((e) => {
    if (e instanceof GuardiansAIError && e.status === 402 && e.code === 'quota_exhausted') {
      console.log('✅ manejo de error HTTP (402 quota_exhausted) OK');
    } else {
      console.error('❌ error inesperado', e);
      process.exit(1);
    }
  });
}).then(() => {
  console.log('\n🎉 Todos los smoke tests pasaron');
}).catch((e) => {
  console.error('❌ Test falló:', e);
  process.exit(1);
});
