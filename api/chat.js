export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_KEY?.trim() ||
    process.env.OPENAI_APIKEY?.trim() ||
    '';

  if (!apiKey) {
    return res.status(500).json({
      error:
        'Missing OpenAI key on server. Set OPENAI_API_KEY in Vercel Environment Variables and redeploy.',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const selectedContext = body.selectedContext || null;

    const cleanedMessages = rawMessages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      .slice(-12);

    if (!cleanedMessages.length) {
      return res.status(400).json({ error: 'No valid messages provided' });
    }

    const contextText = selectedContext
      ? `Current selected drawing context:\n- Title: ${selectedContext.title || 'Unknown'}\n- Instance ID: ${selectedContext.instanceId || 'Unknown'}\n- Archive line: ${selectedContext.secondaryLine || 'Unknown'}`
      : 'No drawing is currently selected.';

    const messages = [
      {
        role: 'system',
        content:
          'You are an assistant for an architecture drawing archive explorer. Keep answers concise, factual, and grounded in visible metadata and graph context. If unsure, say what data is needed.',
      },
      {
        role: 'system',
        content:
          `${contextText}\n\n` +
          'You must return ONLY valid JSON with this exact shape: ' +
          '{"answer":"string","search":{"enabled":boolean,"query":"string","terms":["string"]}}. ' +
          'Set search.enabled=true when the user asks to find/show/compare/list images by: ' +
          'architectural elements (trees, plants, vegetation, landscape, topography, terrain, site plans, elevations, sections, facades, roofs, windows, doors, stairs, corridors), ' +
          'materials/systems (concrete, stone, wood, steel, glass, brick, masonry), ' +
          'building types (housing, residential, office, commercial, institutional, civic, cultural, religious), ' +
          'design concepts (patterns, symmetry, geometry, grids, modularity, repetition), ' +
          'places/regions/cities, or visual/thematic attributes. ' +
          'Examples triggering search: "show me buildings with trees", "find all topography drawings", "what plants appear in these designs", "buildings in Europe". ' +
          'When enabled, set search.query to the main concept and search.terms to 6-12 related keywords, synonyms, and variations in lowercase (e.g., for "trees": ["tree", "vegetation", "landscape", "plants", "greenery", "forest", "botanical", "organic"]). ' +
          'Always trigger search for architectural or site feature queries.',
      },
      ...cleanedMessages,
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 500,
        messages,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const msg = payload?.error?.message || 'OpenAI request failed';
      return res.status(response.status).json({ error: msg });
    }

    const rawContent = payload?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      return res.status(502).json({ error: 'No response returned by model' });
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = {
        answer: rawContent,
        search: { enabled: false, query: '', terms: [] },
      };
    }

    const safe = {
      answer: String(parsed?.answer || '').trim() || rawContent,
      search: {
        enabled: Boolean(parsed?.search?.enabled),
        query: String(parsed?.search?.query || '').trim(),
        terms: Array.isArray(parsed?.search?.terms)
          ? parsed.search.terms.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 16)
          : [],
      },
    };

    // If the user question contains common archive keywords but AI didn't set search.enabled,
    // enable it as a safety net to ensure broad queries always search
    if (!safe.search.enabled && cleanedMessages.length > 0) {
      const userQuestion = cleanedMessages[cleanedMessages.length - 1]?.content?.toLowerCase() || '';
      const archSearchKeywords = [
        'topography', 'topographic', 'terrain',
        'tree', 'trees', 'vegetation', 'plants', 'greenery', 'botanical', 'landscape', 'organic',
        'building', 'buildings', 'architecture', 'architectural', 'structure', 'facade', 'elevation',
        'section', 'sections', 'plan', 'plans', 'site',
        'housing', 'residential', 'office', 'commercial', 'civic', 'institutional',
        'concrete', 'stone', 'wood', 'steel', 'glass', 'brick', 'masonry', 'material',
        'water', 'river', 'bridge', 'street', 'plaza', 'park',
        'pattern', 'patterns', 'geometry', 'grid', 'modular', 'repetition',
        'show me', 'find all', 'find drawings', 'what', 'compare',
      ];
      if (archSearchKeywords.some((kw) => userQuestion.includes(kw))) {
        safe.search.enabled = true;
        if (!safe.search.query) {
          safe.search.query = cleanedMessages[cleanedMessages.length - 1]?.content || '';
        }
      }
    }

    return res.status(200).json(safe);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Server error' });
  }
}
