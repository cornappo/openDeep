import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import multer from 'multer';
import pdfParse from 'pdf-parse';

const { Pool } = pkg
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const EMBEDDING_DIMENSION = 1536;
const EMBEDDING_PROVIDER = 'alibaba';
const CUSTOM_API_BASE = 'https://ws-a4fw98r6kybzg4uu.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const CHAT_BASE_URL = CUSTOM_API_BASE;
const CHAT_API_KEY = process.env.qwenTextEmbedding || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;
const CHAT_MODEL = 'deepseek-chat';
const EMBEDDING_BASE_URL = CUSTOM_API_BASE;
const EMBEDDING_API_KEY = process.env.qwenTextEmbedding || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-v3';

function sanitizeTextForStorage(inputText = '') {
    return String(inputText || '').replace(/\u0000/g, ' ').replace(/\x00/g, ' ');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function buildApiUrl(baseUrl, resourcePath) {
    return `${baseUrl.replace(/\/+$/, '')}/${resourcePath.replace(/^\/+/, '')}`;
}

async function generateEmbedding(text) {
    const cleanText = sanitizeTextForStorage(text).trim();
    if (!cleanText) throw new Error('Impossibile creare un embedding per testo vuoto.');

    if (EMBEDDING_PROVIDER === 'gemini') {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY non configurata: impossibile usare Gemini per gli embedding.');
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: { parts: [{ text: cleanText }] },
                    outputDimensionality: EMBEDDING_DIMENSION
                })
            });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error?.message || `Errore Gemini embeddings HTTP ${response.status}`);
        }

        const embedding = data?.embedding?.values;
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
            throw new Error(`Embedding Gemini non valido: attesi ${EMBEDDING_DIMENSION} valori.`);
        }

        return embedding.map(value => Number(value));
    }

    const apiKey = EMBEDDING_API_KEY || CHAT_API_KEY;
    if (!apiKey) {
        throw new Error('Nessuna API key configurata per gli embedding. Imposta qwenTextEmbedding.');
    }

    const embedCandidates = [
        {
            name: 'openai-compatible',
            payload: { model: EMBEDDING_MODEL, input: cleanText },
            extractor: (data) => data?.data?.[0]?.embedding
        },
        {
            name: 'alibaba-compatible-array',
            payload: { model: EMBEDDING_MODEL, input: { texts: [cleanText] }, dimensions: EMBEDDING_DIMENSION },
            extractor: (data) => data?.data?.[0]?.embedding || data?.output?.data?.[0]?.embedding
        },
        {
            name: 'alibaba-compatible-string',
            payload: { model: EMBEDDING_MODEL, input: [cleanText] },
            extractor: (data) => data?.data?.[0]?.embedding || data?.output?.data?.[0]?.embedding
        }
    ];

    let lastError = null;
    for (const candidate of embedCandidates) {
        try {
            const response = await fetch(buildApiUrl(EMBEDDING_BASE_URL, '/embeddings'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(candidate.payload)
            });

            const data = await response.json();
            if (!response.ok) {
                lastError = new Error(data?.error?.message || data?.message || `Errore embeddings HTTP ${response.status}`);
                continue;
            }

            const embedding = candidate.extractor(data);
            if (Array.isArray(embedding) && embedding.length === EMBEDDING_DIMENSION) {
                return embedding.map(value => Number(value));
            }

            lastError = new Error(`Embedding ${candidate.name} non valido: attesi ${EMBEDDING_DIMENSION} valori.`);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Nessun formato di embedding supportato risposto dal backend.');
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
        await pool.query(`CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);`);
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
        if (!messaggio || !String(messaggio).trim()) {
            return res.status(400).json({ errore: 'Il messaggio non può essere vuoto.' });
        }

        let memRes = await pool.query('SELECT memoria_testo FROM user_memories WHERE user_id = $1', [sessionKey]);
        let memoriaAttuale = memRes.rows[0]?.memoria_testo || "Nessuna informazione registrata.";

        const queryEmbedding = await generateEmbedding(messaggio);
        const contextRes = await pool.query(
            `SELECT id, file_name, chunk_text,
                    1 - (embedding <=> $2::vector) AS similarity
             FROM document_chunks
             WHERE progetto = $1 AND embedding IS NOT NULL
             ORDER BY embedding <=> $2::vector
             LIMIT 8`,
            [progetto, `[${queryEmbedding.join(',')}]`]
        );
        if (contextRes.rows.length === 0) {
            return res.status(422).json({
                errore: 'Nessun documento indicizzato per questo progetto. Allega un PDF o un altro file prima di fare una domanda.'
            });
        }

        const contestoDocumentale = contextRes.rows
            .map(r => `[Fonte: ${r.file_name} | Chunk: ${r.id} | Similarità: ${Number(r.similarity).toFixed(4)}]\n${r.chunk_text}`)
            .join('\n\n');

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
        const apiKey = CHAT_API_KEY || process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            throw new Error('Nessuna API key configurata per il modello. Imposta AI_API_KEY o DEEPSEEK_API_KEY.');
        }

        const aiResponse = await fetch(buildApiUrl(CHAT_BASE_URL, '/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.3 })
        });
        const aiData = await aiResponse.json();
        const durataMs = Date.now() - startTime;

        if (!aiResponse.ok) throw new Error(JSON.stringify(aiData));

        let rispostaIA = aiData?.choices?.[0]?.message?.content || '';
        if (!rispostaIA) {
            throw new Error('La risposta del modello non contiene contenuto valido.');
        }

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
