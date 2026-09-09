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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tasks_log (
                token_task VARCHAR(255) PRIMARY KEY,
                stato VARCHAR(50) NOT NULL,
                log TEXT[],
                risultato TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_memories (
                user_id VARCHAR(255) PRIMARY KEY,
                memoria_testo TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("[LOG DB] Tabelle tasks_log e user_memories verificate o create con successo su Supabase.");
    } catch (err) {
        console.error("[LOG DB] Errore inizializzazione database:", err.message);
        throw err;
    }
}

async function startServer() {
    try {
        await initDatabase();
    } catch (dbErr) {
        console.error("[CRITICAL] Impossibile avviare il server senza connessione al database:", dbErr.message);
        process.exit(1);
    }

    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.get('/api/suggerimenti', (req, res) => {
        res.json([
            { etichetta: "+ Approfonda Analisi", testoPrompt: "Analizza in dettaglio l'ultimo progetto e proponi i prossimi passi operativi." },
            { etichetta: "- Sintetizza Stato", testoPrompt: "Fornisci un riassunto sintetico dello stato attuale delle attività." }
        ]);
    });

    // Rotta Chat e Auto-Aggiornamento Memoria Integrata
    app.post('/api/chat', async (req, res) => {
        const { userId = 'utente_default_demo', progetto = 'Studio Architettura', messaggio } = req.body;
        const sessionKey = `${userId}_${progetto}`;

        if (!messaggio) {
            return res.status(400).json({ errore: "Messaggio mancante." });
        }

        try {
            // 1. Leggi la memoria attuale da Supabase
            let memRes = await pool.query('SELECT memoria_testo FROM user_memories WHERE user_id = $1', [sessionKey]);
            let memoriaAttuale = memRes.rows[0]?.memoria_testo || "Nessuna informazione registrata per questo progetto.";

            // 2. Chiamata a DeepSeek con Cache (System Prompt + Memoria fissa + Messaggio utente)
            const messages = [
                {
                    role: "system",
                    content: "Sei Cervelletto Pro, un assistente strategico intelligente, pulito e professionale. Aiuti l'utente a gestire il suo progetto."
                },
                {
                    role: "system",
                    content: `MEMORIA PERSISTENTE ATTUALE PER QUESTO PROGETTO:\n${memoriaAttuale}`
                },
                {
                    role: "user",
                    content: messaggio
                }
            ];

            const startTime = Date.now();
            const timestampInizio = new Date().toISOString();

            const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: "deepseek-chat",
                    messages: messages,
                    temperature: 0.3
                })
            });

            const aiData = await aiResponse.json();
            const endTime = Date.now();
            const durataMs = endTime - startTime;

            if (!aiResponse.ok) {
                throw new Error(`Errore API DeepSeek (${aiResponse.status}): ${JSON.stringify(aiData)}`);
            }

            let rispostaIA = aiData.choices[0].message.content;

            // 3. Auto-aggiornamento silenzioso della memoria
            const promptMemoria = `
            Analizza l'interazione e aggiorna la memoria del progetto.
            MEMORIA ATTUALE:
            ${memoriaAttuale}

            ULTIMO MESSAGGIO UTENTE: "${messaggio}"
            RISPOSTA IA: "${rispostaIA}"

            Compito: Aggiorna la memoria inserendo nuovi fatti importanti (nomi, relazioni, scelte tecniche, preferenze) in modo sintetico ed elenchi puntati. Restituisci SOLO il testo della nuova memoria aggiornata.
            `;

            const memUpdateRes = await fetch("https://api.deepseek.com/chat/completions", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: "deepseek-chat",
                    messages: [{ role: "user", content: promptMemoria }],
                    temperature: 0.1
                })
            });

            const memUpdateData = await memUpdateRes.json();
            const nuovaMemoria = memUpdateData.choices[0].message.content.trim();

            // 4. Salva la nuova memoria su Supabase
            await pool.query(
                `INSERT INTO user_memories (user_id, memoria_testo, updated_at) 
                 VALUES ($1, $2, NOW()) 
                 ON CONFLICT (user_id) 
                 DO UPDATE SET memoria_testo = $2, updated_at = NOW()`,
                [sessionKey, nuovaMemoria]
            );

            // Aggiunta Log di Sistema alla risposta
            rispostaIA += "\n\n---\n" +
                        "**[SYSTEM LOGS - REAL]**\n" +
                        "- **Modello:** `deepseek-chat`\n" +
                        "- **Timestamp Inizio:** " + timestampInizio + "\n" +
                        "- **Timestamp Fine:** " + new Date().toISOString() + "\n" +
                        "- **Latenza:** " + durataMs + " ms\n" +
                        "- **Token Cache Hit:** " + (aiData.usage?.prompt_cache_hit_tokens || 0) + "\n" +
                        "- **Stato Richiesta:** Completata (HTTP 200)\n";

            res.json({ risposta: rispostaIA, memoriaAggiornata: nuovaMemoria });

        } catch (err) {
            console.error("[LOG CHAT] Errore:", err);
            res.status(500).json({ errore: "Errore interno del server: " + err.message });
        }
    });

    // Rotta per esportare la memoria in formato TXT
    app.get('/api/export-txt', async (req, res) => {
        const { userId = 'utente_default_demo', progetto = 'Studio Architettura' } = req.query;
        const sessionKey = `${userId}_${progetto}`;

        try {
            const memRes = await pool.query('SELECT memoria_testo, updated_at FROM user_memories WHERE user_id = $1', [sessionKey]);
            const memoria = memRes.rows[0]?.memoria_testo || "Nessuna memoria trovata per questo progetto.";
            
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="memoria-${progetto.replace(/\s+/g, '_')}.txt"`);
            res.send(`MEMORIA PROGETTO: ${progetto}\nUltimo aggiornamento: ${memRes.rows[0]?.updated_at || 'N/D'}\n\n${memoria}`);
        } catch (error) {
            res.status(500).send("Errore durante l'esportazione.");
        }
    });

    app.post('/api/avvia-task', async (req, res) => {
        const tokenTask = 'task_' + Date.now();
        try {
            await pool.query(
                `INSERT INTO tasks_log (token_task, stato, log, risultato) VALUES ($1, $2, $3, $4)`,
                [tokenTask, 'IN_CORSO', ["Avvio operazione asincrona...", "Connessione a DeepSeek in corso..."], null]
            );
            res.json({ tokenTask });
        } catch (err) {
            console.error("[LOG DB] Errore avvio task:", err);
            res.status(500).json({ error: "Errore interno durante l'avvio del task." });
        }
    });

    app.post('/api/controlla-stato', async (req, res) => {
        const { tokenTask } = req.body;
        if (!tokenTask) {
            return res.status(400).json({ stato: "ERRORE", log: ["Token mancante."], risultato: "Nessun token fornito." });
        }
        try {
            const checkRes = await pool.query('SELECT * FROM tasks_log WHERE token_task = $1', [tokenTask]);
            if (checkRes.rows.length === 0) {
                return res.status(404).json({ stato: "ERRORE", log: ["Task non trovato."], risultato: null });
            }
            const task = checkRes.rows[0];
            res.json({ stato: task.stato, log: task.log, risultato: task.risultato });
        } catch (err) {
            res.status(500).json({ stato: "ERRORE", log: [err.message], risultato: null });
        }
    });

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT} con Supabase attivo e memoria persistente.`));
}

startServer();
