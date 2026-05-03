// netlify/functions/parse.js
// Proxy to Anthropic Claude API — parses availability transcript into structured schedule.
// Set ANTHROPIC_API_KEY in Netlify dashboard: Site > Environment Variables

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const { transcript, referenceDate, existingSlots } = JSON.parse(event.body);

    const existingContext = existingSlots && existingSlots.length > 0
      ? `\n\nExisting schedule to merge/update:\n${JSON.stringify(existingSlots)}`
      : '';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Today's date is ${referenceDate}. Parse this availability statement into structured JSON.${existingContext}

Statement: "${transcript}"

Return ONLY a JSON object with two fields:
1. "slots": an array where each item has:
   - "date": YYYY-MM-DD
   - "start": HH:mm (24hr) — use "00:00" if unavailable all day
   - "end": HH:mm (24hr) — use "00:00" if unavailable all day  
   - "unavailable": true ONLY if the person explicitly says they are NOT available that date
2. "warnings": an array of strings for any issues found (can be empty)

Rules:
- Expand recurring patterns ("every Monday in June" = list each Monday)
- Handle exclusions ("except June 8th" = mark June 8th as unavailable: true)
- Convert 12hr to 24hr (9am=09:00, 2pm=14:00, 6pm=18:00)
- CRITICAL: Validate day-of-week against the actual calendar date. If someone says "Monday June 8th" but June 8th is actually a Sunday, add a warning like "June 8th is actually a Sunday, not Monday. Used the date June 8th." Always use the DATE they specified, not the day name.
- If merging with existing: apply corrections, keep everything else unchanged
- "remove June 4th" = remove that date from results entirely
- Return ONLY the JSON object, no explanation, no markdown backticks.`
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic error:', response.status, errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Claude returned ${response.status}`, details: errorText }),
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('Parse function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal parsing error', message: err.message }),
    };
  }
};
