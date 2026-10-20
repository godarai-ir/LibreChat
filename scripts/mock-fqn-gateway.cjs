const http = require('http');
const ids = [
  'openai:acme-main:gpt-4o', 'openai:acme-backup:gpt-4o', 'openai:acme-main:gpt-4o-mini',
  'anthropic:team-b:claude-sonnet-4', 'google:proj-1:gemini-2.5-pro', 'legacy-model',
];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }));
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      const { model, stream } = JSON.parse(body || '{}');
      console.log('chat model =', model);
      const text = `model received: ${model}`;
      const chunk = (delta, fin) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model,
        choices: [{ index: 0, delta, finish_reason: fin }] });
      if (!stream) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
      }
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(4010, '0.0.0.0', () => console.log('mock gateway on :4010'));
