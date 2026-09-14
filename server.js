import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import multer from 'multer';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE EXTENSION IF NOT EXISTS vector;
            
            CREATE TABLE IF NOT EXISTS user_memories (
                user_id VARCHAR(255) PRIMARY KEY,
                memoria_testo TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS document_chunks (
                id SERIAL PRIMARY KEY,
                progetto VARCHAR(255) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                chunk_text TEXT NOT NULL,
                embedding vector(1536),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("[LOG DB] Estensione vector e tabelle verificate/create con successo.");
    } catch (err) {
        console.error("[LOG DB] Errore inizializzazione database:", err.message);
    }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Rotta Upload e Chunking file esistente (con rimozione byte nulli 0x00)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    const { progetto = 'Studio Architettura' } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ errore: "Nessun file caricato." });

    try {
        const textContent = file.buffer.toString('utf-8').replace(/\0/g, '');
        const chunkSize = 500;
        const chunks = [];
        for (let i = 0; i < textContent.length; i += chunkSize) {
            chunks.push(textContent.substring(i, i + chunkSize));
        }

        for (const chunk of chunks) {
            const dummyVector = Array(1536).fill(0.1); 
            await pool.query(
                `INSERT INTO document_chunks (progetto, file_name, chunk_text, embedding) VALUES ($1, $2, $3, $4)`,
                [progetto, file.originalname, chunk, `[${dummyVector.join(',')}]`]
            );
        }

        console.log(`[UPLOAD] File ${file.originalname} elaborato in ${chunks.length} chunk per ${progetto}.`);
        res.json({ successo: true, chunksCreati: chunks.length });
    } catch (err) {
        console.error("[UPLOAD ERRORE]:", err);
        res.status(500).json({ errore: err.message });
    }
});

// Nuova Rotta per la creazione o l'append di un documento generato dall'IA
app.post('/api/salva-documento', async (req, res) => {
    const { progetto, fileName, contenuto, modalita = 'nuovo' } = req.body;
    if (!progetto || !fileName || !contenuto) {
        return res.status(400).json({ errore: "Parametri mancanti (progetto, fileName, contenuto)." });
    }

    try {
        const textCleaned = contenuto.replace(/\0/g, '');
        const chunkSize = 500;
        const chunks = [];
        for (let i = 0; i < textCleaned.length; i += chunkSize) {
            chunks.push(textCleaned.substring(i, i + chunkSize));
        }

        for (const chunk of chunks) {
            const dummyVector = Array(1536).fill(0.1);
            await pool.query(
                `INSERT INTO document_chunks (progetto, file_name, chunk_text, embedding) VALUES ($1, $2, $3, $4)`,
                [progetto, fileName.endsWith('.txt') ? fileName : `${fileName}.txt`, chunk, `[${dummyVector.join(',')}]`]
            );
        }

        console.log(`[DOCUMENTO CREATO] ${fileName} salvato con successo per il progetto ${progetto}.`);
        res.json({ successo: true, chunksCreati: chunks.length });
    } catch (err) {
        console.error("[ERRORE SALVATAGGIO DOC]:", err);
        res.status(500).json({ errore: err.message });
    }
});

app.get('/api/allegati', async (req, res) => {
    const { progetto = 'Studio Architettura' } = req.query;
    try {
        const result = await pool.query('SELECT DISTINCT file_name FROM document_chunks WHERE progetto = $1', [progetto]);
        res.json({ files: result.rows.map(r => r.file_name) });
    } catch (err) {
        res.status(500).json({ files: [] });
    }
});

app.post('/api/chat', async (req, res) => {
    const { userId = 'utente_default_demo', progetto = 'Studio Architettura', messaggio } = req.body;
    const sessionKey = `${userId}_${progetto}`;

    try {
        let memRes = await pool.query('SELECT memoria_testo FROM user_memories WHERE user_id = $1', [sessionKey]);
        let memoriaAttuale = memRes.rows[0]?.memoria_testo || "Nessuna informazione registrata.";

        const contextRes = await pool.query(
            `SELECT file_name, chunk_text FROM document_chunks WHERE progetto = $1 ORDER BY id DESC LIMIT 3`,
            [progetto]
        );
        let contestoDocumentale = contextRes.rows.map(r => `[Fonte: ${r.file_name}]\n${r.chunk_text}`).join('\n\n');

        const messages = [
            { 
                role: "system", 
                content: "Sei Cervelletto Pro. Usa la memoria e i documenti allegati per rispondere. Se nella conversazione emerge un contenuto strutturato rilevante che merita di essere salvato o aggiunto a un documento, includi chiaramente una sezione JSON nascosta o formattata nel testo con la struttura: ```json-doc {\"fileName\": \"nome_file.txt\", \"contenuto\": \"...\"} ```." 
            },
            { role: "system", content: `MEMORIA GLOBALE:\n${memoriaAttuale}` },
            { role: "system", content: `ESTRATTI DOCUMENTALI PERTINENTI:\n${contestoDocumentale}` },
            { role: "user", content: messaggio }
        ];

        const startTime = Date.now();
        const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
            body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.3 })
        });
        const aiData = await aiResponse.json();
        const durataMs = Date.now() - startTime;

        if (!aiResponse.ok) throw new Error(JSON.stringify(aiData));

        let rispostaIA = aiData.choices[0].message.content;

        rispostaIA += "\n\n---\n" +
            "**[SYSTEM LOGS - REAL]**\n" +
            "- **Modello:** `deepseek-chat`\n" +
            "- **Timestamp Inizio:** " + new Date().toISOString() + "\n" +
            "- **Latenza:** " + durataMs + " ms\n" +
            "- **Stato Richiesta:** Completata (HTTP 200)\n";

        res.json({ risposta: rispostaIA });
    } catch (err) {
        res.status(500).json({ errore: "Errore interno: " + err.message });
    }
});

app.get('/api/export-txt', async (req, res) => {
    const { userId = 'utente_default_demo', progetto = 'Studio Architettura' } = req.query;
    const sessionKey = `${userId}_${progetto}`;
    const memRes = await pool.query('SELECT memoria_testo FROM user_memories WHERE user_id = $1', [sessionKey]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(memRes.rows[0]?.memoria_testo || "Memoria vuota.");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server attivo sulla porta ${PORT}`);
    await initDatabase();
});
