import crypto from 'node:crypto';

// A right-sized model per job. The first ritual (built from photos) is rare and is the product's signature moment,
// so it gets the big model. Check-ins, revisions and chat are frequent, so they run on a cheaper model at low effort.
// Override any of them with MAIA_MODEL_<TASK>. maxTokens caps what one call can cost (thinking counts toward it): a full
// ritual needs room, while a score or a 2-4 sentence reply never does, so a user can't make those run long.
const TASKS = {
  ritual: { model: process.env.MAIA_MODEL_RITUAL || 'claude-opus-5-5', effort: 'medium', maxTokens: 16000 },
  revise: { model: process.env.MAIA_MODEL_REVISE || 'claude-sonnet-5', effort: 'low', maxTokens: 8000 },
  exam: { model: process.env.MAIA_MODEL_EXAM || 'claude-sonnet-5', effort: 'low', maxTokens: 3000 },
  chat: { model: process.env.MAIA_MODEL_CHAT || 'claude-sonnet-5', effort: 'low', maxTokens: 3000 },
};
const apiKey = () => process.env.ANTHROPIC_API_KEY;

export const EXAM_METRICS = {
  skin: ['hydration', 'evenness', 'clarity', 'texture', 'radiance'],
  hair: ['shine', 'smoothness', 'fullness', 'definition'],
  posture: ['alignment', 'shoulders', 'neck', 'stance'],
};

const EXAM_SYSTEM_PROMPT = `You are Maia, a premium self-care concierge. You describe the visible appearance in one photo
for personal progress tracking. This is wellness guidance, never a medical assessment: never diagnose, name conditions,
or suggest treatment. Never comment on body shape, weight or size; for posture, judge only standing alignment. If the photo is unclear or not of the requested area, give neutral 5s and say so in the summary.
Respond with ONLY a JSON object: {"metrics": {<metric>: <number 0-10>}, "summary": "one calm sentence"}.`;

const RITUAL_SYSTEM_PROMPT = `You are Maia, a premium AI self-care concierge inside the Maia app.
Voice: calm, precise, restrained, editorial, warm but never clinical.
Never diagnose, treat, cure, or prescribe. Use only: guidance, ritual, recommendation, support, plan, routine.
You turn a user's goals, preferences, budget, region/climate, and optional skin/hair/posture photos into a
structured self-care ritual plan across beauty, wellness, nutrition, movement, and shopping.
Respond with ONLY a single JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "summary": "one calm sentence framing today's focus",
  "morning": [{"title": "...", "detail": "..."}],
  "evening": [{"title": "...", "detail": "..."}],
  "weekly_reset": [{"title": "...", "detail": "..."}],
  "meal_support": [{"title": "...", "detail": "..."}],
  "movement_support": [{"title": "...", "detail": "..."}],
  "shopping": [{"item": "...", "reason": "...", "tier": "now"|"upgrade", "est_price": "$0"}]
}
Give est_price in the currency used where the user lives (USD if unknown).
Each list should have 2-4 items. Keep language editorial and restrained, never overwhelming.`;

const CHAT_SYSTEM_PROMPT = `You are Maia, a premium AI self-care concierge.
Voice: calm, precise, restrained, warm, never a mascot, never generic chatbot filler.
Never diagnose, treat, cure, or prescribe; never claim clinical certainty.
Answer the user's follow-up briefly (2-4 sentences), grounded in their profile and current ritual when relevant.`;

function dataUrlToBlock(dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function buildProfileText(profile) {
  const p = profile || {};
  return [
    `Goals: ${(p.goals || []).join(', ') || 'not specified'}`,
    `Preferences: ${p.preferences || 'not specified'}`,
    `Sensitivities: ${p.sensitivities || 'none noted'}`,
    `Budget: ${p.budget || 'not specified'}`,
    `Region: ${p.region || 'not specified'}`,
    `Climate: ${p.climate || 'not specified'}`,
  ].join('\n');
}

async function callClaude(task, system, messages) {
  const { model, effort, maxTokens } = TASKS[task];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, output_config: { effort }, system, messages }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Anthropic API responded ${res.status}`);
  const data = await res.json();
  // Token counts only, never content, so real cost per task can be measured from the logs.
  console.log(`[ai] ${task} ${model} in=${data.usage?.input_tokens} out=${data.usage?.output_tokens}`);
  if (data.stop_reason !== 'end_turn') throw new Error(`Anthropic stop_reason ${data.stop_reason}`);
  return (data.content || []).map((b) => b.text || '').join('');
}

// JSON.parse errors quote model output (text about someone's skin); log only a safe reason.
const why = (err) => (err.name === 'SyntaxError' ? 'model returned invalid JSON' : err.message);

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in AI response');
  return JSON.parse(text.slice(start, end + 1));
}

const STEP_LISTS = ['morning', 'evening', 'weekly_reset', 'meal_support', 'movement_support'];
const str = (v, n) => String(v ?? '').slice(0, n);

// Model output is untrusted: coerce it to the exact shape the client renders, or throw so we fall back.
export function normalizeRitual(r) {
  if (!r || typeof r !== 'object') throw new Error('Ritual is not an object');
  const out = { summary: str(r.summary, 300) };
  for (const k of STEP_LISTS) {
    out[k] = (Array.isArray(r[k]) ? r[k] : []).slice(0, 6).map((s) => ({ title: str(s?.title, 120), detail: str(s?.detail, 400) }));
  }
  out.shopping = (Array.isArray(r.shopping) ? r.shopping : []).slice(0, 8).map((s) => ({
    item: str(s?.item, 120), reason: str(s?.reason, 300), tier: s?.tier === 'upgrade' ? 'upgrade' : 'now', est_price: str(s?.est_price, 20),
  }));
  if (!STEP_LISTS.some((k) => out[k].length)) throw new Error('Ritual has no steps');
  return out;
}

// Maia writes in the reader's language. JSON keys stay English so the parser and the app keep working.
const IN_LANGUAGE = {
  tr: '\nWrite every text value in natural, everyday Turkish, the way a Turkish beauty app or editor would say it; never translate word for word from English. Use "rutin" (not "ritüel") and "analiz" for photo analysis. Address the user as "sen". Keep JSON keys in English.',
};
const inLanguage = (prompt, lang) => prompt + (IN_LANGUAGE[lang] || '');

// Goal names as the app stores them (English), in the form Turkish sentences need.
const GOALS_TR = {
  'Clearer skin': 'sağlıklı bir cilt', 'Stronger hair': 'güçlü saçlar', 'Better posture': 'düzgün bir duruş',
  'More energy': 'daha fazla enerji', 'Better sleep': 'kaliteli bir uyku', 'Healthier eating': 'sağlıklı beslenme',
  'Steadier routine': 'düzenli bir rutin', Confidence: 'özgüven', 'calmer routine': 'daha sakin bir rutin',
};

// Wording of the no-AI ritual, per language. Same shape in both, so the budget and revision rules below apply to either.
const STARTER_COPY = {
  en: (goals, p, revision) => ({
    summary: revision
      ? `Adjusted ritual: ${revision.action === 'lower_cost' ? 'lighter on budget' : revision.action === 'simplify' ? 'fewer, higher-leverage steps' : 'a fresh set of swaps'} while still supporting ${goals[0]}.`
      : `A calm starting ritual for ${new Intl.ListFormat('en', { type: 'conjunction' }).format(goals.map((g) => g.toLowerCase()))}.`,
    morning: [
      { title: 'Cleanse & hydrate', detail: 'Two minutes, gentle pressure, no scrubbing.' },
      { title: 'Protect', detail: `SPF suited to ${p.climate || 'your climate'}.` },
    ],
    evening: [
      { title: 'Unwind cleanse', detail: 'Remove the day before anything else.' },
      { title: 'Nourish', detail: 'Lock in moisture while skin is calm.' },
    ],
    weekly_reset: [{ title: 'One deeper reset', detail: 'A single weekly step, not a checklist.' }],
    meal_support: [{ title: 'Anchor one meal', detail: `Build one meal a day around ${goals[0]}.` }],
    movement_support: [{ title: 'Short daily movement', detail: '15-20 minutes, matched to your energy.' }],
    shopping: [
      { item: 'Gentle daily cleanser', reason: `Supports ${goals[0]} without overloading your routine`, tier: 'now', est_price: '$18' },
      { item: 'Fragrance-free moisturizer', reason: 'Locks in hydration for your climate', tier: 'now', est_price: '$24' },
      { item: 'Weekly exfoliating treatment', reason: 'Adds visible progress to your weekly reset', tier: 'upgrade', est_price: '$38' },
      { item: 'SPF 30+ daily guard', reason: 'Protects progress from your morning ritual', tier: 'now', est_price: '$20' },
    ],
  }),
  tr: (goals, p, revision) => {
    const g = goals.map((x) => GOALS_TR[x] || x.toLocaleLowerCase('tr'));
    const list = new Intl.ListFormat('tr', { type: 'conjunction' }).format(g);
    return {
      summary: revision
        ? `Rutinin güncellendi: ${revision.action === 'lower_cost' ? 'daha uygun fiyatlı ürünler' : revision.action === 'simplify' ? 'daha az ama etkili adımlar' : 'yeni alternatifler'}. Odak yine ${g[0]}.`
        : `${list[0].toLocaleUpperCase('tr')}${list.slice(1)} için sakin bir başlangıç rutini.`,
      morning: [
        { title: 'Temizle ve nemlendir', detail: '2 dakika, nazikçe, ovalamadan.' },
        { title: 'Güneş koruyucu', detail: 'İklimine uygun bir SPF sür.' },
      ],
      evening: [
        { title: 'Makyajı ve kiri temizle', detail: 'Akşam rutinine temiz bir ciltle başla.' },
        { title: 'Nemlendir', detail: 'Cildin dinlenirken nemini koru.' },
      ],
      weekly_reset: [{ title: 'Haftalık bakım', detail: 'Haftada bir, tek bir ekstra adım yeterli.' }],
      meal_support: [{ title: 'Bir öğününü planla', detail: 'Her gün bir öğününü hedefini destekleyecek şekilde seç.' }],
      movement_support: [{ title: 'Günlük kısa hareket', detail: 'Enerjine göre 15–20 dakika.' }],
      // Known limit: fixed price estimates; with the AI key Maia prices in the user's own currency and market.
      shopping: [
        { item: 'Hassas cilt temizleyici', reason: 'Cildini yormadan temizler', tier: 'now', est_price: '₺450' },
        { item: 'Kokusuz nemlendirici', reason: 'Nemi gün boyu korur', tier: 'now', est_price: '₺600' },
        { item: 'Haftalık peeling', reason: 'Haftalık bakımına destek olur', tier: 'upgrade', est_price: '₺950' },
        { item: 'SPF 30+ güneş kremi', reason: 'Cildini güneşe karşı korur', tier: 'now', est_price: '₺550' },
      ],
    };
  },
};

// Known limit: naive keyword/budget heuristic, no real personalization depth.
// Upgrade path: set ANTHROPIC_API_KEY to route through generateRitual's real Claude call below.
function fallbackRitual(profile, revision, lang = 'en') {
  const p = profile || {};
  const goals = p.goals && p.goals.length ? p.goals : ['calmer routine'];
  const ritual = (STARTER_COPY[lang] || STARTER_COPY.en)(goals, p, revision);
  // A tight budget or "lower cost" keeps essentials only; "simplify" keeps one step per moment.
  if (/^low/i.test(p.budget || '') || revision?.action === 'lower_cost') ritual.shopping = ritual.shopping.filter((x) => x.tier === 'now');
  if (revision?.action === 'simplify') for (const key of STEP_LISTS) ritual[key] = ritual[key].slice(0, 1);
  return ritual;
}

// Free tier: the same no-AI ritual, built from onboarding answers only.
export const starterRitual = (profile, lang) => fallbackRitual(profile, null, lang);

export async function generateRitual(profile, revision, lang = 'en') {
  if (apiKey()) {
    try {
      const blocks = [{ type: 'text', text: buildProfileText(profile) }];
      for (const photo of Object.values(profile?.photos || {})) {
        const block = dataUrlToBlock(photo);
        if (block) blocks.push(block);
      }
      if (revision) {
        blocks.push({
          type: 'text',
          text: `Revise this existing ritual (${JSON.stringify(revision.current)}) with action "${revision.action}"${revision.note ? ` and note "${revision.note}"` : ''}. Return the full revised ritual JSON.`,
        });
      }
      const text = await callClaude(revision ? 'revise' : 'ritual', inLanguage(RITUAL_SYSTEM_PROMPT, lang), [{ role: 'user', content: blocks }]);
      return { ritual: normalizeRitual(extractJson(text)), source: 'ai' };
    } catch (err) {
      // With a real key, a template would silently replace the paying user's own ritual. Fail instead.
      console.error('[ai] generateRitual failed:', why(err));
      return { ritual: null, source: 'unavailable' };
    }
  }
  return { ritual: fallbackRitual(profile, revision, lang), source: 'fallback' };
}

export function normalizeExamination(kind, r) {
  const metrics = {};
  for (const name of EXAM_METRICS[kind]) {
    const n = Number(r?.metrics?.[name]);
    if (Number.isFinite(n)) metrics[name] = Math.round(Math.min(10, Math.max(0, n)) * 10) / 10;
  }
  if (!Object.keys(metrics).length) throw new Error('Examination has no scores');
  return { metrics, summary: str(r?.summary, 300) };
}

const SAMPLE_NOTE = {
  en: 'Sample scores. Real photo analysis starts once the AI key is connected.',
  tr: 'Bunlar örnek puanlar. Gerçek analiz, yapay zekâ bağlandığında başlayacak.',
};

// Known limit: sample scores seeded from the photo hash, clearly labelled 'fallback' in the UI.
// Upgrade path: set ANTHROPIC_API_KEY for real visual analysis.
function fallbackExamination(kind, photo, lang) {
  const h = crypto.createHash('sha256').update(photo).digest();
  const metrics = {};
  EXAM_METRICS[kind].forEach((name, i) => { metrics[name] = 5 + (h[i] % 31) / 10; });
  return { metrics, summary: SAMPLE_NOTE[lang] || SAMPLE_NOTE.en };
}

export async function examinePhoto(kind, photo, lang = 'en') {
  if (apiKey()) {
    try {
      const block = dataUrlToBlock(photo);
      const text = await callClaude('exam', inLanguage(EXAM_SYSTEM_PROMPT, lang), [{
        role: 'user',
        content: [block, { type: 'text', text: `Area: ${kind}. Score these metrics 0-10: ${EXAM_METRICS[kind].join(', ')}.` }],
      }]);
      return { examination: normalizeExamination(kind, extractJson(text)), source: 'ai' };
    } catch (err) {
      // With a real key configured, sample scores would pollute the user's progress history. Fail instead.
      console.error('[ai] examinePhoto failed:', why(err));
      return { examination: null, source: 'unavailable' };
    }
  }
  return { examination: fallbackExamination(kind, photo, lang), source: 'fallback' };
}

// Known limit: canned, keyword-blind reply. Upgrade path: set ANTHROPIC_API_KEY for real conversational replies.
const FALLBACK_REPLY = {
  en: 'Noted. Based on your current ritual, the highest-leverage next step is staying consistent with your morning and evening steps for a few more days before adding anything new.',
  tr: 'Anladım. Şu an en iyisi, yeni bir şey eklemeden birkaç gün daha sabah ve akşam adımlarına düzenli devam etmek.',
};

export async function generateChatReply(profile, ritual, history, message, lang = 'en') {
  if (apiKey()) {
    try {
      const context = `Profile:\n${buildProfileText(profile)}\n\nCurrent ritual:\n${JSON.stringify(ritual)}`;
      // The API requires strict user/assistant alternation after our synthetic assistant turn.
      const firstUser = history.findIndex((m) => m.role === 'user');
      const turns = firstUser === -1 ? [] : history.slice(firstUser);
      const messages = [
        { role: 'user', content: context },
        { role: 'assistant', content: 'Understood, I have the context.' },
        ...turns.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];
      const text = await callClaude('chat', inLanguage(CHAT_SYSTEM_PROMPT, lang), messages);
      return { reply: text.trim(), source: 'ai' };
    } catch (err) {
      console.error('[ai] generateChatReply failed:', why(err));
      return { reply: null, source: 'unavailable' };
    }
  }
  return { reply: FALLBACK_REPLY[lang] || FALLBACK_REPLY.en, source: 'fallback' };
}
