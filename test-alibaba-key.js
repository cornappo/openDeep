import process from 'node:process';

const apiKey = process.env.qwenTextEmbedding || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;
const baseUrl = 'https://ws-756pfhanyfvqhdkw.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

if (!apiKey) {
  console.error('Manca la chiave. Imposta: export qwenTextEmbedding="..."');
  process.exit(1);
}

async function testEmbeddings() {
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-DashScope-WorkSpace': 'ws-756pfhanyfvqhdkw'
    },
    body: JSON.stringify({
      model: 'text-embedding-v3',
      input: 'test di verifica chiave alibaba'
    })
  });

  const text = await response.text();
  console.log('STATUS:', response.status);
  console.log('BODY:', text);
}

async function testChat() {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-DashScope-WorkSpace': 'ws-756pfhanyfvqhdkw'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Rispondi solo con OK' }],
      temperature: 0.2
    })
  });

  const text = await response.text();
  console.log('CHAT STATUS:', response.status);
  console.log('CHAT BODY:', text);
}

try {
  await testEmbeddings();
  console.log('---');
  await testChat();
} catch (error) {
  console.error('ERRORE:', error.message);
  process.exit(1);
}
