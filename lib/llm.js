'use strict';
// Provider-agnostic LLM client. Uses Node 22's global fetch (no SDK dependency),
// so "connect to any API key" just means: pick a provider preset (or Custom) and
// paste a key. Each provider returns the assistant text; we parse JSON from it.

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-opus-4-8',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    keyEnv: 'OPENAI_API_KEY',
  },
  ollama: {
    label: 'Ollama (local, no key)',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'qwen2.5', 'mistral'],
    keyEnv: null,
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyEnv: null,
  },
};

async function callAnthropic({ baseUrl, apiKey, model, system, user }) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((c) => c.text || '').join('');
}

// OpenAI-compatible (also covers Ollama and most custom gateways).
async function callOpenAICompatible({ baseUrl, apiKey, model, system, user }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

/** Extract the first JSON object from a possibly-markdown-wrapped response. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in LLM response');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Ask the configured LLM to optimize slicing parameters.
 * @param {object} cfg  { provider, baseUrl, apiKey, model }
 * @param {object} ctx  { printer, material, analysis, goal }
 * @returns parsed parameter recommendation object
 */
async function optimizeSlicing(cfg, ctx) {
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
  const baseUrl = cfg.baseUrl || provider.baseUrl;
  const model = cfg.model || provider.defaultModel;

  const system = [
    'You are an expert FDM 3D-printing slicing engineer.',
    'Given a printer, a base material profile, and a geometric analysis of a model,',
    'you output OPTIMIZED slicing parameters tuned to THIS model and printer.',
    'Respect the printer firmware quirks exactly (e.g. never suggest G-code the firmware',
    'does not support). Reply with ONLY a JSON object, no prose.',
    'The JSON schema is:',
    '{',
    '  "layer_height_mm": number,',
    '  "initial_layer_height_mm": number,',
    '  "line_width_mm": number,',
    '  "wall_count": integer,',
    '  "top_bottom_layers": integer,',
    '  "infill_density_pct": number,',
    '  "infill_pattern": "grid"|"gyroid"|"triangles"|"cubic"|"lines",',
    '  "nozzle_temp_c": number,',
    '  "bed_temp_c": number,',
    '  "print_speed_mms": number,',
    '  "initial_layer_speed_mms": number,',
    '  "retraction_distance_mm": number,',
    '  "retraction_speed_mms": number,',
    '  "fan_speed_pct": number,',
    '  "supports_enabled": boolean,',
    '  "support_angle_deg": number,',
    '  "adhesion": "none"|"skirt"|"brim"|"raft",',
    '  "rationale": string  // 2-4 sentences explaining the key tradeoffs',
    '}',
  ].join('\n');

  const user = JSON.stringify(
    {
      goal: ctx.goal || 'balanced quality and speed',
      printer: ctx.printer.machine,
      firmware_quirks: ctx.printer.firmware_quirks,
      base_material: ctx.material,
      model_analysis: ctx.analysis,
    },
    null,
    2
  );

  const text =
    cfg.provider === 'anthropic'
      ? await callAnthropic({ baseUrl, apiKey: cfg.apiKey, model, system, user })
      : await callOpenAICompatible({ baseUrl, apiKey: cfg.apiKey, model, system, user });

  const params = extractJson(text);
  return params;
}

module.exports = { PROVIDERS, optimizeSlicing, extractJson };
