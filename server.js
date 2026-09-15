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

// ==========================================
// CONFIGURAZIONE fissa estratta dal CSV Alibaba
// ==========================================
const ALIBABA_CONFIG = {
    workspaceId: 'ws-756pfhanyfvqhdkw',
    apiKey: 'sk-ws-H.DHLXEEH.ol2X.MEUCIAX18p9Zm-acQclxyq97FXejj9GiOp-gN-CWYlNSwSqtAiEArRH6oR7LvnadThvdTOwSqt',
    chatBaseUrl: 'https://ws-756pfhanyfvqhdkw.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    chatModel: 'deepseek-chat',
    embeddingBaseUrl: 'https://ws-756pfhanyfvqhdkw.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v3'
};

function sanitizeTextForStorage(inputText = '') {
    return String(inputText || '').replace(/\u0000/g, ' ').replace(/\x00/g, ' ');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Il database PostgreSQL usa la stringa di connessione (puoi impostarla o lasciarla da env per il DB)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function buildApiUrl(baseUrl, resourcePath) {
    return `${baseUrl.replace(/\/+$/, '')}/${resourcePath.replace(/^\/+/, '')}`;
}

function buildAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ALIBABA_CONFIG.apiKey}`,
        'X-DashScope-WorkSpace': ALIBABA_CONFIG.workspaceId
    };
}

async function generateEmbedding(text) {
    const cleanText = sanitizeTextForStorage(text).trim();
    if (!cleanText) throw new Error('Impossibile creare un embedding per testo vuoto.');

    const payload = {
        model: ALIBABA_CONFIG.embeddingModel,
        input: cleanText
    };

    const response = await fetch(buildApiUrl(ALIBABA_CONFIG.embeddingBaseUrl, '/embeddings'), {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
        console.error("[ERRORE EMBEDDING API DETTAGLIATO]:", JSON.stringify(data, null, 2));
        throw new Error(data?.error?.message || data?.message || `Errore embeddings HTTP ${response.status}`);
    }

    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
        throw new Error('Formato risposta embedding non valido dal backend.');
    }

    return embedding.map(value => Number(value));
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
                throw new Error("Il file PDF risulta privo di un layer di testo estraibile nativamente.");
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
    const { progetto, fileName, contenuto } = req.body;
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
                content: "Sei Cervelletto Pro. Usa la memoria e i documenti allegati per rispondere." 
            },
            { role: "system", content: `MEMORIA GLOBALE:\n${memoriaAttuale}` },
            { role: "system", content: `ESTRATTI DOCUMENTALI PERTINENTI:\n${contestoDocumentale}` },
            { role: "user", content: messaggio }
        ];

        const startTime = Date.now();

        const aiResponse =- await fetch(buildApiUrl(ALIBABA_CONFIG.chatBaseUrl, '/chat/completions'), {
            method: 'POST',
            headers: buildAuthHeaders(),
            body: JSON.stringify({ model: ALIBABA_CONFIG.chatModel, messages, temperature: 0.3 })
        });
        const aiData = await aiResponse.json();
        const durataMs = Date.now() - startTime;

        if (!aiResponse.ok) throw new Error(JSON.stringify(aiData));

        let rispostaIA = aiData?.choices?. [0]?.message?.content || '';
        if (!rispostaIA) {
            throw new Error('La risposta del modello non contiene contenuto valido.');
        }

        rispostaIA += "\n\n---\n" +
            "**[SYSTEM LOGS - REAL]**\n" +
            "- **Modello:** `" + ALIBABA_CONFIG.chatModel + "`\n" +
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