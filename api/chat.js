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
        content: contextText,
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

    const answer = payload?.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return res.status(502).json({ error: 'No response returned by model' });
    }

    return res.status(200).json({ answer });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Server error' });
  }
}
