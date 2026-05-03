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
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Today is ${referenceDate} (year ${referenceDate.split('-')[0]}). Parse availability into JSON.${existingContext}

"${transcript}"

Return JSON object: {"slots": [...], "warnings": [...]}

Each slot: {"date":"YYYY-MM-DD", "start":"HH:mm", "end":"HH:mm"} or add "unavailable":true if they said NOT available.

Key rules:
- Year is ${referenceDate.split('-')[0]} unless stated otherwise
- "June 4th, 5th, and 6th" = exactly 3 dates, NOT every day in June
- "every Saturday in May" = only the Saturdays in May ${referenceDate.split('-')[0]}
- Skip dates before ${referenceDate}
- 9am=09:00, 2pm=14:00, etc
- If day name doesn't match date (e.g. "Monday June 8" but June 8 is not Monday), add warning, use the date
- Merging: newer entries replace same-date conflicts
- Return ONLY the JSON, no markdown, no explanation.`
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
