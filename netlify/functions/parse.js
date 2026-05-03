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
          content: `Today's date is ${referenceDate} (the current year is ${referenceDate.split('-')[0]}). Parse this availability statement into structured JSON.${existingContext}

Statement: "${transcript}"

Return ONLY a JSON object with two fields:
1. "slots": an array where each item has:
   - "date": YYYY-MM-DD (always use the year ${referenceDate.split('-')[0]} unless another year is explicitly stated)
   - "start": HH:mm (24hr) — use "00:00" if unavailable all day
   - "end": HH:mm (24hr) — use "00:00" if unavailable all day  
   - "unavailable": true ONLY if the person explicitly says they are NOT available that date
2. "warnings": an array of strings for any issues found (can be empty)

Rules:
- CRITICAL DISTINCTION between recurring patterns and specific dates:
  * "every Saturday in May" or "all Saturdays in June" = ONLY the dates that are actually Saturdays in that month. NOT every day in the month.
  * "June 4th, 5th, and 6th" = ONLY those three specific dates. NOT every day in June.
  * "every Monday and Wednesday in July" = ONLY the Mondays and Wednesdays in July.
  * "the whole month of June" or "every day in June" = every day in June.
- Only expand to multiple dates when the user explicitly says "every [day]" or "all [days]" in a month. Listing specific dates like "4th, 5th, and 6th" means ONLY those dates.
- Handle exclusions ("except June 8th" = mark June 8th as unavailable: true)
- Convert 12hr to 24hr (9am=09:00, 2pm=14:00, 6pm=18:00)
- CRITICAL DAY VALIDATION: When the user says a day name AND a date (like "Monday June 8th"), verify the day-of-week for that date in ${referenceDate.split('-')[0]}. If they don't match, add a warning. Always use the DATE number they said.
- If the user only says a day name without a specific date (like "every Monday"), use the correct dates that ARE that day in ${referenceDate.split('-')[0]}.
- Do NOT include dates before ${referenceDate}. Only include today or future dates.
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
