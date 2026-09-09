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

// Configurazione Connessione Supabase / PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inizializzazione della tabella persistente nel database
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
        `);
        console.log("[LOG DB] Tabella tasks_log verificata o creata con successo su Supabase.");
    } catch (err) {
        console.error("[LOG DB] Errore inizializzazione database:", err.message);
    }
}

initDatabase();

// Serve l'interfaccia HTML dalla cartella public
app.use(express.static(path.join(__dirname, 'public')));

// Fallback se index.html si trova nella root del progetto
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint per i suggerimenti iniziali
app.get('/api/suggerimenti', (req, res) => {
    res.json([
        { etichetta: "+ Approfonda Analisi", testoPrompt: "Analizza in dettaglio l'ultimo progetto e proponi i prossimi passi operativi." },
        { etichetta: "- Sintetizza Stato", testoPrompt: "Fornisci un riassunto sintetico dello stato attuale delle attività." }
    ]);
});

// Endpoint per avviare il task asincrono
app.post('/api/avvia-task', async (req, res) => {
    const tokenTask = 'task_' + Date.now();
    try {
        await pool.query(
            `INSERT INTO tasks_log (token_task, stato, log) VALUES ($1, $2, $3)`,
            [tokenTask, 'IN_CORSO', ["Avvio operazione asincrona...", "Connessione a DeepSeek in corso..."]]
        );
        res.json({ tokenTask });
    } catch (err) {
        console.error("[LOG DB] Errore avvio task:", err);
        res.status(500).json({ error: "Errore interno durante l'avvio del task." });
    }
});

// Endpoint per controllare lo stato (sostituisce activeTasks in-memory con Supabase)
app.post('/api/controlla-stato', async (req, res) => {
    const { tokenTask, payloadUtente, fileAllegato } = req.body;
    
    try {
        // Verifica se il task esiste già nel database
        const checkRes = await pool.query('SELECT * FROM tasks_log WHERE token_task = $1', [tokenTask]);
        
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ stato: "ERRORE", log: ["Task non trovato."], risultato: "Token non valido." });
        }

        let currentTask = checkRes.rows[0];

        // Se il task è appena stato registrato o avviato, facciamo partire la chiamata in background
        if (currentTask.stato === 'IN_CORSO' && (!currentTask.risultato || currentTask.risultato === '')) {
            // Eseguiamo la chiamata a DeepSeek in modo asincrono
            EseguiChiamataDeepSeek(payloadUtente, fileAllegato)
                .then(async risultato => {
                    await pool.query(
                        `UPDATE tasks_log SET stato = $1, log = $2, risultato = $3 WHERE token_task = $4`,
                        ['COMPLETATO', ["Operazione completata con successo."], risultato, tokenTask]
                    );
                })
                .catch(async err => {
                    await pool.query(
                        `UPDATE tasks_log SET stato = $1, log = $2, risultato = $3 WHERE token_task = $4`,
                        ['ERRORE', ["Errore durante l'esecuzione."], err.toString(), tokenTask]
                    );
                });
        }

        // Restituisce lo stato attuale formattato per il frontend
        res.json({
            stato: currentTask.stato,
            log: currentTask.log,
            risultato: currentTask.risultato
        });

    } catch (err) {
        console.error("[LOG DB] Errore controllo stato:", err);
        res.status(500).json({ stato: "ERRORE", log: ["Errore database"], risultato: err.toString() });
    }
});

async function EseguiChiamataDeepSeek(inputUtente, fileInfo) {
    const apiKeyDeepSeek = process.env.DEEPSEEK_API_KEY;
    if (!apiKeyDeepSeek) {
        throw new Error("Chiave API DeepSeek non configurata nelle variabili d'ambiente di Render.");
    }

    let testoCompletoInput = inputUtente || "";
    if (fileInfo && fileInfo.base64Data) {
        testoCompletoInput += "\n[File allegato ricevuto: " + fileInfo.name + "]";
    }

    const promptSistema = "Sei il Cervelletto strategico e il copilota cognitivo personale.\n" +
                "Analizza la richiesta e restituisci una risposta dettagliata in Markdown.";

    const startTime = Date.now();
    const timestampInizio = new Date().toISOString();

    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKeyDeepSeek}`
        },
        body: JSON.stringify({
            "model": "deepseek-chat",
            "messages": [
                { "role": "system", "content": promptSistema },
                { "role": "user", "content": testoCompletoInput }
            ],
            "stream": false
        })
    });

    const data = await response.json();
    const endTime = Date.now();
    const durataMs = endTime - startTime;

    if (!response.ok) {
        throw new Error(`Errore API DeepSeek (${response.status}): ${JSON.stringify(data)}`);
    }

    let rispostaIA = data.choices[0].message.content;
    
    // Inclusione dei log come richiesto dalle preferenze
    rispostaIA += "\n\n---\n" +
                  "**[SYSTEM LOGS - REAL]**\n" +
                  "- **Modello:** `deepseek-chat`\n" +
                  "- **Timestamp Inizio:** " + timestampInizio + "\n" +
                  "- **Timestamp Fine:** " + new Date().toISOString() + "\n" +
                  "- **Latenza:** " + durataMs + " ms\n" +
                  "- **Stato Richiesta:** Completata (HTTP 200)\n";

    return rispostaIA;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT}`));
