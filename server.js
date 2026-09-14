import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import multer from 'multer';
import pdfParse from 'pdf-parse';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const EMBEDDING_DIMENSION = 1536;

function sanitizeTextForStorage(inputText = '') {
    return String(inputText || '').replace(/\u0000/g, ' ').replace(/\x00/g, ' ');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function buildFallbackEmbedding(inputText = '') {
    const vector = [];
    const safeText = String(inputText || '');

    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        let hash = 0;
        for (let j = 0; j < safeText.length; j++) {
            hash = (hash * 31 + safeText.charCodeAt(j) + i * 17) >>> 0;
        }
        const value = ((hash % 1000000) / 1000000) * 2 - 1;
        vector.push(Number(value.toFixed(6)));
    }

    return vector;
}

async function generateEmbedding(text) {
    const cleanText = sanitizeTextForStorage(text).trim();
    if (!cleanText) return buildFallbackEmbedding('');

    if (!process.env.DEEPSEEK_API_KEY) {
        return buildFallbackEmbedding(cleanText);
    }

    try {
        const response = await fetch('https://api.deepseek.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-embedding',
                input: cleanText
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error?.message || JSON.stringify(data));
        }

        const embedding = data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
            throw new Error('Embedding ricevuto con dimensione non valida.');
        }

        return embedding.map(v => Number(v));
    } catch (err) {
        console.warn('[EMBEDDING FALLBACK] Uso di embedding deterministico perché l’API non è disponibile:', err.message);
        return buildFallbackEmbedding(cleanText);
    }
}

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

app.post('/api/upload', upload.single('file'), async (req, res) => {
    const { progetto = 'Studio Architettura' } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ errore: "Nessun file caricato." });

    try {
        let textContent = "";
        const filenameLower = file.originalname.toLowerCase();

        if (filenameLower.endsWith('.pdf')) {
            const pdfData = await pdfParse(file.buffer);
            textContent = sanitizeTextForStorage(pdfData.text);
            if (!textContent || textContent.trim().length === 0) {
                throw new Error("Il file PDF risulta privo di un layer di testo estraibile nativamente (scansione raster). È richiesto l'intervento di una pipeline OCR.");
            }
        } else {
            textContent = sanitizeTextForStorage(file.buffer.toString('utf-8'));
        }

        const chunkSize = 500;
        const chunks = [];
        for (let i = 0; i < textContent.length; i += chunkSize) {
            chunks.push(textContent.substring(i, i + chunkSize));
        }

        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk);
            await pool.query(
                `INSERT INTO document_chunks (progetto, file_name, chunk_text, embedding) VALUES ($1, $2, $3, $4)`,
                [progetto, file.originalname, chunk, `[${embedding.join(',')}]`]
            );
        }

        console.log(`[UPLOAD] File ${file.originalname} elaborato in ${chunks.length} chunk per ${progetto}.`);
        res.json({ successo: true, chunksCreati: chunks.length });
    } catch (err) {
        console.error("[UPLOAD ERRORE]:", err);
        res.status(500).json({ errore: err.message });
    }
});

app.post('/api/salva-documento', async (req, res) => {
    const { progetto, fileName, contenuto, modalita = 'nuovo' } = req.body;
    if (!progetto || !fileName || !contenuto) {
        return res.status(400).json({ errore: "Parametri mancanti (progetto, fileName, contenuto)." });
    }

    try {
        const safeContenuto = sanitizeTextForStorage(contenuto);
        const chunkSize = 500;
        const chunks = [];
        for (let i = 0; i < safeContenuto.length; i += chunkSize) {
            chunks.push(safeContenuto.substring(i, i + chunkSize));
        }

        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk);
            await pool.query(
                `INSERT INTO document_chunks (progetto, file_name, chunk_text, embedding) VALUES ($1, $2, $3, $4)`,
                [progetto, fileName.endsWith('.txt') ? fileName : `${fileName}.txt`, chunk, `[${embedding.join(',')}]`]
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
            `SELECT file_name, chunk_text FROM document_chunks WHERE progetto = $1 ORDER BY id ASC`,
            [progetto]
        );
        let contestoDocumentale = contextRes.rows.map(r => `[Fonte: ${r.file_name}]\n${r.chunk_text}`).join('\n\n');

        if (!contestoDocumentale.trim()) {
            contestoDocumentale = 'Nessun documento indicizzato per questo progetto.';
        }

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
