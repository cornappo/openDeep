import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// Pagina di test per confermare che il server funzioni
app.get('/', (req, res) => {
    res.send("Cervelletto Pro è online e scalabile su Railway!");
});

// L'endpoint per chiamare DeepSeek
app.post('/api/cervello', async (req, res) => {
    const userPrompt = req.body.prompt;
    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "user", content: userPrompt }]
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Errore di connessione" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT}`));