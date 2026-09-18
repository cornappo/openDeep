import os
import json
import requests
import spaces
import gradio as gr
from transformers import pipeline

print("[LOG] Inizializzazione openDeepAi con Google Drive & Multilingual AI...")

# Client ID Google OAuth
CLIENT_ID = "936267332054-5hntf4kfvvpov6fh99b405csr5u5tljg.apps.googleusercontent.com"

# --- 1. FUNZIONE GOOGLE DRIVE (Eseguita su CPU per non sprecare ZeroGPU) ---
def create_drive_vault(oauth_token: str):
    try:
        if not oauth_token or not oauth_token.strip():
            return "❌ Inserisci prima il token di accesso OAuth di Google ottenuto dopo il login."
            
        headers = {
            "Authorization": f"Bearer {oauth_token.strip()}",
            "Content-Type": "application/json"
        }
        
        search_url = "https://www.googleapis.com/drive/v3/files"
        params = {
            "q": "name='openDeepAi_Vault' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            "spaces": "drive"
        }
        
        response = requests.get(search_url, headers=headers, params=params)
        if response.status_code == 200:
            files = response.json().get("files", [])
            if files:
                folder_id = files[0]["id"]
                return f"✅ Cartella 'openDeepAi_Vault' già esistente sul tuo Google Drive! (ID: {folder_id})"
                
        create_url = "https://www.googleapis.com/drive/v3/files"
        metadata = {
            "name": "openDeepAi_Vault",
            "mimeType": "application/vnd.google-apps.folder"
        }
        create_resp = requests.post(create_url, headers=headers, json=metadata)
        if create_resp.status_code == 200:
            folder_id = create_resp.json().get("id")
            return f"🚀 Cartella 'openDeepAi_Vault' creata con successo nel tuo Google Drive! (ID: {folder_id})"
        else:
            return f"⚠️ Errore Google Drive API ({create_resp.status_code}): {create_resp.text}"
            
    except Exception as e:
        return f"❌ Errore critico: {str(e)}"

# --- 2. MODELLO AI MULTILINGUE DI ANONIMIZZAZIONE (Protetto da @spaces.GPU) ---
ner_pipeline = None

def get_ner_pipeline():
    global ner_pipeline
    if ner_pipeline is None:
        print("[LOG] Caricamento del modello NER multilingue in memoria...")
        ner_pipeline = pipeline(
            "token-classification", 
            model="Babelscape/wikineural-multilingual-ner", 
            aggregation_strategy="simple"
        )
    return ner_pipeline

@spaces.GPU
def anonymize_text(text: str):
    try:
        if not text or not text.strip():
            return "⚠️ Inserisci del testo valido da anonimizzare."
            
        nlp = get_ner_pipeline()
        entities = nlp(text)
        
        # Ordiniamo le entità dalla fine all'inizio per evitare sfasamenti di indici durante la sostituzione
        entities_sorted = sorted(entities, key=lambda x: x['start'], reverse=True)
        
        masked_text = text
        for ent in entities_sorted:
            start = ent.get('start', 0)
            end = ent.get('end', 0)
            entity_group = ent.get('entity_group', 'ENTITY')
            masked_text = masked_text[:start] + f"[{entity_group}]" + masked_text[end:]
            
        return masked_text
    except Exception as e:
        return f"❌ Errore durante l'anonimizzazione AI: {str(e)}"

# --- 3. SCRIPT JS PER AUTO-COMPILAZIONE TOKEN ---
auto_token_js = """
() => {
    const hash = window.location.hash;
    if (hash && hash.includes('access_token=')) {
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            sessionStorage.setItem('openDeep_oauth_token', token);
            console.log("[LOG] Token catturato e salvato in sessionStorage.");
        }
    }

    const tryFillAndSubmit = () => {
        const token = sessionStorage.getItem('openDeep_oauth_token');
        if (!token) return;

        const inputEl = document.querySelector('#token_input input') || document.querySelector('#token_input textarea');
        
        if (inputEl) {
            inputEl.value = token;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            console.log("[LOG] Token inserito automaticamente nel campo Gradio.");

            if (window.location.hash.includes('access_token')) {
                history.replaceState(null, null, window.location.pathname);
            }

            setTimeout(() => {
                const btn = document.querySelector('#create_btn');
                if (btn) {
                    btn.click();
                    console.log("[LOG] Clic automatico sul pulsante di creazione avviato.");
                    sessionStorage.removeItem('openDeep_oauth_token');
                }
            }, 600);
        } else {
            setTimeout(tryFillAndSubmit, 200);
        }
    };

    setTimeout(tryFillAndSubmit, 400);
}
"""

# --- 4. INTERFACCIA GRADIO CON SCHEDE ---
with gr.Blocks(title="openDeepAi - Workspace", js=auto_token_js) as demo:
    gr.Markdown("# 🧠 openDeepAi - Workspace Sicuro")
    gr.Markdown("Gestione Vault Cloud e Motore di Anonimizzazione Testi Multilingue basato su IA.")
    
    with gr.Tabs():
        # Scheda 1: Google Drive Vault
        with gr.TabItem("📁 Google Drive Vault"):
            gr.Markdown("Collega il tuo account Google per configurare il Vault privato.")
            with gr.Row():
                login_url = f"https://accounts.google.com/o/oauth2/v2/auth?client_id={CLIENT_ID}&redirect_uri=https://andreatammail-opendeepai.hf.space&response_type=token&scope=https://www.googleapis.com/auth/drive.file"
                gr.HTML(f'<a href="{login_url}" target="_blank"><button style="background-color: #4285F4; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: bold;">🔐 Ottieni Token Google</button></a>')

            token_input = gr.Textbox(
                label="Token di Accesso Google OAuth (Auto-compilato)", 
                type="password", 
                placeholder="Il token verrà inserito automaticamente qui...",
                elem_id="token_input"
            )
            create_btn = gr.Button(
                "📁 Crea Cartella 'openDeepAi_Vault' sul mio Drive", 
                variant="primary",
                elem_id="create_btn"
            )
            output_box = gr.Textbox(label="Esito Operazione", lines=3)
            
            create_btn.click(
                fn=create_drive_vault,
                inputs=[token_input], 
                outputs=[output_box]
            )

        # Scheda 2: Anonimizzatore IA Multilingue
        with gr.TabItem("🛡️ Anonimizzatore AI"):
            gr.Markdown("Inserisci un testo in qualsiasi lingua (gestisce maiuscole e minuscole) per mascherare automaticamente dati sensibili, nomi e luoghi.")
            with gr.Row():
                input_text = gr.Textbox(label="Testo originale da anonimizzare", lines=5, placeholder="Es. Mario Rossi lavora a Roma per la Apple...")
            
            anonymize_btn = gr.Button("🔒 Anonimizza Testo", variant="primary")
            output_text = gr.Textbox(label="Testo Anonimizzato", lines=5)
            
            anonymize_btn.click(
                fn=anonymize_text,
                inputs=[input_text],
                outputs=[output_text]
            )

print("[LOG] Interfaccia Gradio avanzata pronta con Drive e IA multilingue.")

if __name__ == "__main__":
    demo.launch()