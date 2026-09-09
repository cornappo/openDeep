import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_memories (
                user_id VARCHAR(255) PRIMARY KEY,
                memoria_testo TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("[LOG DB] Tabella user_memories verificata con successo su Supabase.");
    } catch (err) {
        console.error("[LOG DB] Errore creazione tabella user_memories:", err.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/chat', async (req, res) => {
    const { userId = 'utente_default_demo', progetto = 'Studio Architettura', messaggio } = req.body;
    const sessionKey = `${userId}_${progetto}`;

    console.log(`[CHAT] Ricevuto messaggio per sessione: ${sessionKey} -> "${messaggio}"`);

    if (!messaggio) {
        return res.status(400).json({ errore: "Messaggio mancante." });
    }

    try {
        let memRes = await pool.query('SELECT memoria_testo FROM user_memories WHERE user_id = $1', [sessionKey]);
        let memoriaAttuale = memRes.rows[0]?.memoria_testo || "Nessuna informazione registrata per questo progetto.";
        console.log(`[MEMORIA LETTA] ${memoriaAttuale}`);

        const messages = [
            { role: "system", content: "Sei Cervelletto Pro, un assistente strategico intelligente e pulito." },
            { role: "system", content: `MEMORIA PERSISTENTE ATTUALE:\n${memoriaAttuale}` },
            { role: "user", content: messaggio }
        ];

        const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.3 })
        });

        const aiData = await aiResponse.json();
        if (!aiResponse.ok) throw new Error(JSON.stringify(aiData));

        let rispostaIA = aiData.choices[0].message.content;

        const promptMemoria = `Aggiorna la memoria del progetto basandoti sull'interazione.\nMEMORIA ATTUALE:\n${memoriaAttuale}\n\nULTIMO MESSAGGIO:\n"${messaggio}"\nRISPOSTA:\n"${rispostaIA}"\nRestituisci SOLO il testo della nuova memoria aggiornata.`;

        const memUpdateRes = await fetch("https://api.deepseek.com/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: promptMemoria }], temperature: 0.1 })
        });

        const memUpdateData = await memUpdateRes.json();
        const nuovaMemoria = memUpdateData.choices[0].message.content.trim();
        console.log(`[NUOVA MEMORIA GENERATA] ${nuovaMemoria}`);

        await pool.query(
            `INSERT INTO user_memories (user_id, memoria_testo, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (user_id) 
             DO UPDATE SET memoria_testo = $2, updated_at = NOW()`,
            [sessionKey, nuovaMemoria]
        );
        console.log(`[DB SUCCESS] Memoria salvata correttamente su Supabase per ${sessionKey}`);

        res.json({ risposta: rispostaIA, memoriaAggiornata: nuovaMemoria });

    } catch (err) {
        console.error("[LOG CHAT ERRORE]:", err);
        res.status(500).json({ errore: "Errore interno: " + err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Server avviato sulla porta ${PORT}`);
    await initDatabase();
});
