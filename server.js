import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve l'interfaccia HTML dalla cartella public (o direttamente se index.html è nella root)
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
app.post('/api/avvia-task', (req, res) => {
    const tokenTask = 'task_' + Date.now();
    res.json({ tokenTask });
});

// Mappa in memoria per tracciare lo stato dei task
const activeTasks = {};

app.post('/api/controlla-stato', async (req, res) => {
    const { tokenTask, payloadUtente, fileAllegato } = req.body;
    
    if (!activeTasks[tokenTask]) {
        activeTasks[tokenTask] = { 
            stato: "IN_CORSO", 
            log: ["Avvio operazione asincrona...", "Connessione a DeepSeek in corso..."] 
        };
        
        EseguiChiamataDeepSeek(payloadUtente, fileAllegato)
            .then(risultato => {
                activeTasks[tokenTask] = { 
                    stato: "COMPLETATO", 
                    log: ["Operazione completata con successo."], 
                    risultato 
                };
            })
            .catch(err => {
                activeTasks[tokenTask] = { 
                    stato: "ERRORE", 
                    log: ["Errore durante l'esecuzione."], 
                    risultato: err.toString() 
                };
            });
    }

    res.json(activeTasks[tokenTask]);
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
    
    // Inclusione dei log come richiesto dalle tue preferenze
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
