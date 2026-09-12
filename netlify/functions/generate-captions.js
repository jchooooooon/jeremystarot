const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { tone, topic, count } = JSON.parse(event.body || '{}');
    const n = Math.max(1, Math.min(30, parseInt(count, 10) || 0));
    if (!n) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'count is required' }) };
    }

    const anthropic = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });

    const prompt = `너는 짧은 요리 과정 영상(나레이션 없음)에 들어갈 자막 초안을 쓰는 카피라이터야.
영상은 클립 ${n}개를 순서대로 이어붙인 것이고, 각 클립은 1.5~2초짜리 아주 짧은 순간이야.
주제: ${topic || '요리 과정'}
톤/분위기: ${tone || '친근하고 담백하게'}

클립 순서대로 캡션을 ${n}개 만들어줘. 규칙:
- 각 캡션은 한글 기준 12자 이내로 아주 짧게 (자막이 1.5~2초만 노출됨)
- 번호나 설명 없이 캡션 텍스트만
- 각 줄에 캡션 하나씩, 총 ${n}줄
- 과장된 이모지·느낌표 남발 금지`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    let captions = text
      .split('\n')
      .map(line => line.replace(/^\s*[\d.\-\)]+\s*/, '').trim())
      .filter(Boolean);

    if (captions.length > n) captions = captions.slice(0, n);
    while (captions.length < n) captions.push('');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ captions })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to generate captions', details: error.message })
    };
  }
};
