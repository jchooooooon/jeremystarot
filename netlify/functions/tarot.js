const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event, context) => {
  // CORS 헤더 설정
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const anthropic = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });

    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      messages: [
        { role: "user", content: "타로 카드 '은둔자(과거)', '세계(현재)', '태양(미래)' 세 장이 나왔어. 이 조합에 대한 전체적인 운세를 신비롭고 다정한 어조로 풀이해줘." }
      ],
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reading: response.content[0].text })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch reading", details: error.message })
    };
  }
};
