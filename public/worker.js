// Double Twenty Worker.
// Serves the app from ./public as before, and adds one private endpoint:
//   POST /api/food  — sends a food photo to Claude and returns estimated nutrition.
//
// Two secrets are set in the Cloudflare dashboard (never in this file or on GitHub):
//   ANTHROPIC_API_KEY  your key from console.anthropic.com
//   APP_PASSCODE       a passcode you choose; the app sends it with every photo
// Optional plain variable:
//   FOOD_MODEL         which Claude model to use (defaults to claude-sonnet-5-5)

const MAX_IMAGE_BYTES = 4_000_000; // the app sends ~200–400 KB, this is a safety cap

const SYSTEM = `You are a sports nutritionist estimating the nutrition of food from a single photo, for a strength-training app used in New Zealand.
List each distinct food or drink you can see as its own item. Estimate the portion actually on the plate, using cutlery, plates, hands and packaging for scale.
Give calories, protein, carbohydrate and fat for that whole visible portion, not per 100 g.
Include likely hidden extras that change the numbers a lot (cooking oil, butter, dressings, sauces) as separate items with low confidence, but only when they are probably there.
Use New Zealand food names where natural (kumara, mince, capsicum). Round calories to the nearest 5 and grams of macros to one decimal place.
If the photo shows packaged food with a visible nutrition panel, use the panel.
If the photo contains no food or drink, set is_food to false and explain briefly in notes.
Keep notes to one or two short, practical sentences.`;

const TOOL = {
  name: 'report_meal',
  description: 'Report the foods seen in the photo with estimated portions and nutrition.',
  input_schema: {
    type: 'object',
    properties: {
      is_food: { type: 'boolean', description: 'False if there is no food or drink in the photo.' },
      meal_name: { type: 'string', description: 'Short name for the whole meal, e.g. "Chicken, rice and broccoli".' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Food name, e.g. "Grilled chicken breast".' },
            portion: { type: 'string', description: 'Portion in everyday terms, e.g. "1 palm-sized piece" or "about 1 cup".' },
            grams: { type: 'number', description: 'Estimated weight in grams.' },
            kcal: { type: 'number' },
            protein_g: { type: 'number' },
            carbs_g: { type: 'number' },
            fat_g: { type: 'number' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
          },
          required: ['name', 'portion', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence']
        }
      },
      notes: { type: 'string', description: 'One or two short tips, e.g. what would improve the estimate.' }
    },
    required: ['is_food', 'items']
  }
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

// Compare passcodes without leaking timing information
function same(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 10) / 10)) : 0;
};
const text = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

async function handleFood(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!env.ANTHROPIC_API_KEY || !env.APP_PASSCODE)
    return json({ error: 'The analyser isn’t set up yet: add the ANTHROPIC_API_KEY and APP_PASSCODE secrets in Cloudflare.' }, 503);
  if (!same(request.headers.get('x-app-passcode'), env.APP_PASSCODE))
    return json({ error: 'Wrong passcode.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const image = String(body.image || '');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(body.mediaType) ? body.mediaType : 'image/jpeg';
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: 'No photo received.' }, 400);
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: 'That photo is too large.' }, 413);
  const note = text(body.note, 200);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env.FOOD_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1500,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'report_meal' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: note ? `Extra detail from the person who ate it: ${note}` : 'Estimate the nutrition of this food.' }
          ]
        }]
      })
    });
  } catch {
    return json({ error: 'Couldn’t reach Claude. Try again in a moment.' }, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || '';
    console.log('Anthropic error', res.status, msg); // visible in Cloudflare's Worker logs
    if (res.status === 401) return json({ error: 'Claude didn’t accept the API key. Check the ANTHROPIC_API_KEY secret.' }, 502);
    if (res.status === 429) return json({ error: 'Too many requests just now. Wait a minute and try again.' }, 429);
    if (/credit|billing/i.test(msg)) return json({ error: 'Your Anthropic account is out of credit. Top it up at console.anthropic.com.' }, 502);
    if (res.status === 404 || /model/i.test(msg)) return json({ error: 'The Claude model name wasn’t recognised. Check the FOOD_MODEL variable.' }, 502);
    return json({ error: 'Claude couldn’t analyse that photo. Try again.' }, 502);
  }

  const tool = (data.content || []).find((b) => b.type === 'tool_use');
  const r = (tool && tool.input) || {};
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, 15).map((x) => ({
    name: text(x.name, 60) || 'Food',
    portion: text(x.portion, 80),
    grams: num(x.grams, 5000),
    kcal: Math.round(num(x.kcal, 5000)),
    p: num(x.protein_g, 500),
    c: num(x.carbs_g, 1000),
    f: num(x.fat_g, 500),
    conf: ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : 'medium'
  }));
  return json({
    is_food: r.is_food !== false && items.length > 0,
    meal_name: text(r.meal_name, 80),
    items,
    notes: text(r.notes, 300)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/food') return handleFood(request, env);
    return env.ASSETS.fetch(request); // everything else: the app's files in ./public
  }
};
