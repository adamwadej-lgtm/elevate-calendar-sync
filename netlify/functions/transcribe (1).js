// netlify/functions/transcribe.js
// Proxy to Deepgram REST API — receives base64 audio from browser, sends raw bytes to Deepgram.
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
    let audioBuffer;
    let contentType = 'audio/webm';

    // Check if body is JSON (base64 encoded audio) or raw binary
    const bodyContentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

    if (bodyContentType.includes('application/json')) {
      // New format: JSON with base64 audio
      const payload = JSON.parse(event.body);
      audioBuffer = Buffer.from(payload.audio, 'base64');
      contentType = payload.mimeType || 'audio/webm';
    } else {
      // Legacy format: raw binary
      audioBuffer = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'binary');
      contentType = bodyContentType || 'audio/webm';
    }

    console.log(`Transcribing: ${audioBuffer.length} bytes, type: ${contentType}`);

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
