// netlify/functions/transcribe.js
// Thin proxy to Deepgram REST API — bypasses CORS for browser clients.
// Set DEEPGRAM_API_KEY in Netlify dashboard: Site > Environment Variables

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'DEEPGRAM_API_KEY not configured' }) };
  }

  try {
    // The body comes as base64 when isBase64Encoded is true
    const audioBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body);

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || 'audio/webm';

    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': contentType,
        },
        body: audioBuffer,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Deepgram error:', response.status, errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Deepgram returned ${response.status}`, details: errorText }),
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('Transcribe function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal transcription error', message: err.message }),
    };
  }
};
