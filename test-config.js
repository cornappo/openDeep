const apiKey = process.env.ALIBABA_API_KEY;
const ALIBABA_CONFIG = {
	workspaceId: process.env.ALIBABA_WORKSPACE_ID || 'ws-756pfhanyfvqhdkw',
	apiKey,
	chatBaseUrl: process.env.ALIBABA_CHAT_BASE_URL || 'https://ws-756pfhanyfvqhdkw.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
	chatModel: process.env.ALIBABA_CHAT_MODEL || 'deepseek-chat'
};

if (!apiKey) {
	console.error('Manca ALIBABA_API_KEY. Impostala come variabile d\'ambiente.');
	process.exit(1);
}

async function testAlibabaApi() {
	console.log('[TEST] Avvio test di connessione con Alibaba Cloud...');
	try {
		const response = await fetch(`${ALIBABA_CONFIG.chatBaseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${ALIBABA_CONFIG.apiKey}`,
				'X-DashScope-WorkSpace': ALIBABA_CONFIG.workspaceId
			},
			body: JSON.stringify({
				model: ALIBABA_CONFIG.chatModel,
				messages: [{ role: 'user', content: 'Ciao! Rispondi solo con: Test superato con successo.' }],
				temperature: 0.3
			})
		});
		const data = await response.json();
		console.log('[TEST] HTTP Status:', response.status);
		if (response.ok) {
			console.log('[TEST] Risposta dal modello:', data?.choices?.[0]?.message?.content);
			console.log('[TEST COMPLETO] Configurazione funzionante al 100%!');
		} else {
			console.error('[TEST ERRORE API]:', JSON.stringify(data, null, 2));
		}
	} catch (err) {
		console.error('[TEST ERRORE DI RETE]:', err.message);
	}
}

testAlibabaApi();