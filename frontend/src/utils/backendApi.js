export async function explainMatch(payload) {
  const response = await fetch('/api/explain-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Backend explain-match request failed');
  }

  return response.json();
}

export async function extractBoardTitle(payload) {
  const response = await fetch('/api/extract-board-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Backend extract-board-title request failed');
  return response.json();
}

export async function extractImageMetadata(payload) {
  const response = await fetch('/api/extract-image-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Backend extract-image-metadata request failed');
  return response.json();
}
