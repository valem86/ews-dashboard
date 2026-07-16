// APP.JS - LOGICA DASHBOARD EARLY WARNING SYSTEM

const HARDCODED_PASSWORD = "EwsSecurePassword2026!"; // Verrà compilata automaticamente dallo script static_exporter.py
const API_URL = '/api/data';
const RUN_EWS_URL = '/api/run_ews';

let dbData = null; // Memorizza i dati caricati
let map = null;
let shipsLayer = null;
let gdeltChart = null;
let gdeltChartDates = []; // Date YYYY-MM-DD usate dal grafico (aggiornate a ogni render)
let currentCountryFilter = 'ALL';
let currentTimeWindow = 30; // Finestra temporale attiva: 7 | 30 | 90 | null (tutto)
let startDateFilter = null;
let endDateFilter = null;

// Inizializzazione al caricamento del DOM
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initFlatpickr();
    loadData();
    setupEventListeners();
    setupGraphTabs();
});

// Tab dei grafi di rete (Wiki / ACLED) dentro un'unica card.
// vis-network creato in un contenitore nascosto ha dimensione 0:
// forziamo redraw + fit quando la tab diventa visibile.
function setupGraphTabs() {
    const tabs = document.querySelectorAll('.graph-tab');
    if (!tabs.length) return;
    const panes = {
        wiki: document.getElementById('wiki-graph-pane'),
        acled: document.getElementById('acled-graph-pane')
    };
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.graph;
            tabs.forEach(t => {
                const on = t === tab;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            Object.entries(panes).forEach(([key, pane]) => {
                if (pane) pane.hidden = (key !== target);
            });
            setTimeout(() => {
                const net = target === 'wiki' ? wikiNetwork
                          : target === 'acled' ? acledNetwork : null;
                if (net) { net.redraw(); net.fit({ animation: false }); }
            }, 60);
        });
    });
}

// Inizializzazione Flatpickr per scelta range date su calendario
function initFlatpickr() {
    flatpickr("#date-range", {
        mode: "range",
        locale: "it",
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "d/m/Y",
        theme: "dark",
        onChange: function(selectedDates, dateStr, instance) {
            if (selectedDates.length === 2) {
                startDateFilter = instance.formatDate(selectedDates[0], "Y-m-d");
                endDateFilter = instance.formatDate(selectedDates[1], "Y-m-d");
            } else if (selectedDates.length === 0) {
                startDateFilter = null;
                endDateFilter = null;
            } else {
                // Selezione di un singolo giorno (primo click)
                startDateFilter = instance.formatDate(selectedDates[0], "Y-m-d");
                endDateFilter = null;
            }
            if (dbData) {
                renderTimeline(dbData.notes);
            }
        }
    });
}

// 1. INIZIALIZZAZIONE DELLA MAPPA LEAFLET (ZOOM POSIZIONATO IN BASSO A DESTRA)
function initMap() {
    // Inizializza la mappa centrata nel Mediterraneo Centrale, disabilitando lo zoom control in alto a sinistra
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false
    }).setView([37.0, 15.0], 5.5);

    // Tile Layer: CartoDB Dark Matter (Tema scuro premium)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19
    }).addTo(map);

    // Riposiziona lo zoom control in basso a destra per non sovrapporsi al menu a tendina su mobile
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    shipsLayer = L.layerGroup().addTo(map);
}

// 2. RECUPERO DEI DATI DAL BACKEND (CON COMPATIBILITÀ SERVER LOCALE E STATICO CIFRATO)
async function loadData() {
    const btnRefresh = document.getElementById('btn-refresh');
    const refreshIcon = btnRefresh?.querySelector('i');
    
    if (btnRefresh && refreshIcon) {
        refreshIcon.classList.add('fa-spin');
        btnRefresh.disabled = true;
    }

    // A. Proviamo prima a contattare l'API locale
    try {
        const response = await fetch(API_URL);
        if (response.ok) {
            dbData = await response.json();
            renderDashboardComponents();
            return;
        }
    } catch (localApiError) {
        console.log("ℹ️ Server API locale non raggiungibile, provo modalità statica...", localApiError);
    }

    // B. Se l'API fallisce, proviamo a cercare il file cifrato statico
    try {
        const responseEncrypted = await fetch('data_encrypted.txt');
        if (responseEncrypted.ok) {
            const encryptedBase64 = await responseEncrypted.text();
            
            // 0. Controlla prima se c'è una password pre-configurata direttamente nel codice
            let hardcodedPassword = typeof HARDCODED_PASSWORD !== 'undefined' ? HARDCODED_PASSWORD : "";
            
            // 1. Controlla se la password è già salvata nella memoria locale del browser (localStorage)
            let savedPassword = localStorage.getItem('ews_dashboard_key') || "";
            
            // 2. Controlla in seconda battuta se è nell'URL dopo il # (per compatibilità o prima configurazione)
            let urlPassword = window.location.hash ? decodeURIComponent(window.location.hash.substring(1)) : "";
            let passwordToTry = hardcodedPassword || savedPassword || urlPassword;
            
            if (passwordToTry) {
                try {
                    const decryptedText = await decryptData(encryptedBase64, passwordToTry);
                    const parsedData = JSON.parse(decryptedText);
                    if (parsedData.last_updated) {
                        dbData = parsedData;
                        
                        // Se ha avuto successo ed era nell'URL, salvala in locale e pulisci l'URL
                        if (urlPassword && !savedPassword && !hardcodedPassword) {
                            localStorage.setItem('ews_dashboard_key', urlPassword);
                        }
                        
                        // Rimuove l'hash #... dall'URL visibile mantenendo l'indirizzo pulito
                        if (window.location.hash) {
                            history.replaceState(null, null, window.location.pathname + window.location.search);
                        }
                        
                        renderDashboardComponents();
                        setupStaticRefreshButton();
                        return; // Sbloccato con successo!
                    }
                } catch (decryptError) {
                    console.log("⚠️ Password automatica/salvata non valida, procedo a modale.", decryptError);
                    localStorage.removeItem('ews_dashboard_key'); // Rimuoviamo la password errata
                }
            }
            
            // 3. Richiedi la password tramite overlay grafico (se non trovata o errata)
            showPasswordModal(async (password) => {
                const decryptedText = await decryptData(encryptedBase64, password);
                const parsedData = JSON.parse(decryptedText);
                if (!parsedData.last_updated) {
                    throw new Error("Dati decifrati non validi.");
                }
                dbData = parsedData;
                
                // Salva la password nella memoria del browser per i futuri accessi automatici
                localStorage.setItem('ews_dashboard_key', password);
                
                // Pulisci l'URL rimuovendo l'hash temporaneo
                if (window.location.hash) {
                    history.replaceState(null, null, window.location.pathname + window.location.search);
                }
                
                renderDashboardComponents();
                setupStaticRefreshButton();
            });
            return;
        }
    } catch (staticEncryptedError) {
        console.log("ℹ️ File cifrato non trovato o errore di decrittografia, provo file in chiaro...", staticEncryptedError);
    }

    // C. Come ultima spiaggia, proviamo a caricare un data.json statico in chiaro (se presente)
    try {
        const responseClear = await fetch('data.json');
        if (responseClear.ok) {
            dbData = await responseClear.json();
            renderDashboardComponents();
            setupStaticRefreshButton();
            return;
        }
    } catch (staticClearError) {
        console.log("❌ File statico in chiaro non raggiungibile:", staticClearError);
    }

    // D. Se tutto fallisce, mostra l'errore all'utente
    alert("Impossibile caricare i dati. Assicurati che il server locale Python sia avviato, oppure che i file di dati statici siano presenti nella cartella.");
    if (btnRefresh && refreshIcon) {
        refreshIcon.classList.remove('fa-spin');
        btnRefresh.disabled = false;
    }
}

// Funzione di supporto per renderizzare tutti i componenti una volta pronti i dati
function renderDashboardComponents() {
    renderLastUpdated(dbData.last_updated);
    renderWarningMatrix(dbData.warning_matrix);
    renderShipsOnMap(dbData.ngo_ships);
    renderChart(dbData.gdelt_history);
    renderTimeline(dbData.notes);
    renderAcledHeatmap(dbData.acled_history || []);
    initAcledMapLayer(dbData.acled_events || []);
    renderWikiGraph(dbData.wiki_graph || { nodes: [], edges: [] });
    renderAcledGraph(dbData.acled_graph || { nodes: [], edges: [] });

    // Disattiva spin caricamento se presente
    const btnRefresh = document.getElementById('btn-refresh');
    const refreshIcon = btnRefresh?.querySelector('i');
    if (btnRefresh && refreshIcon) {
        refreshIcon.classList.remove('fa-spin');
        btnRefresh.disabled = false;
    }
}

// Configura il bottone per comportarsi in modalità offline/statica
function setupStaticRefreshButton() {
    const btnRefresh = document.getElementById('btn-refresh');
    if (btnRefresh) {
        // Rimuove eventuali listener precedenti clonando l'elemento
        const newBtn = btnRefresh.cloneNode(true);
        btnRefresh.parentNode.replaceChild(newBtn, btnRefresh);
        
        newBtn.addEventListener('click', () => {
            alert("La dashboard è in modalità statica online. Per aggiornare i dati, esegui lo script di aggiornamento ('static_exporter.py') dal tuo computer di casa.");
        });
    }
}

// UTILITY DI DECRITTOGRAFIA LATO CLIENT (SENZA DIPENDENZE)
function base64ToBytes(base64) {
    const binaryString = atob(base64.replace(/\s/g, ''));
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return new Uint8Array(hashBuffer);
}

async function decryptData(encryptedBase64, password) {
    const dataBytes = base64ToBytes(encryptedBase64);
    const result = new Uint8Array(dataBytes.length);
    const chunkSize = 32;
    
    for (let i = 0; i < Math.ceil(dataBytes.length / chunkSize); i++) {
        const inputStr = password + i;
        const h = await sha256(inputStr);
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, dataBytes.length);
        for (let j = start; j < end; j++) {
            result[j] = dataBytes[j] ^ h[j - start];
        }
    }
    
    return new TextDecoder().decode(result);
}

// MOSTRA MODALE DI INSERIMENTO PASSWORD GRAFICA
function showPasswordModal(onSuccess) {
    const existing = document.getElementById('security-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'security-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(6, 10, 26, 0.98)';
    overlay.style.backdropFilter = 'blur(10px)';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.fontFamily = "'Inter', sans-serif";
    overlay.style.color = '#fff';
    
    overlay.innerHTML = `
        <div style="text-align: center; max-width: 400px; padding: 40px; border-radius: 8px; background: rgba(13, 21, 46, 0.9); border: 2px solid #00f0ff; box-shadow: 0 0 30px rgba(0, 240, 255, 0.2); text-shadow: none;">
            <div style="font-size: 50px; margin-bottom: 20px; color: #00f0ff; filter: drop-shadow(0 0 10px rgba(0, 240, 255, 0.5));">
                <i class="fa-solid fa-lock"></i>
            </div>
            <h2 style="margin-bottom: 10px; font-weight: 700; letter-spacing: 1px; color: #fff; font-size: 20px; text-transform: uppercase;">ACCESSO RISERVATO</h2>
            <p style="font-size: 13px; color: #94a3b8; margin-bottom: 25px; line-height: 1.5;">Questa dashboard EWS contiene dati sensibili protetti da crittografia. Inserisci la chiave di decrittografia per accedere.</p>
            <div style="position: relative; width: 100%; margin-bottom: 20px;">
                <input type="password" id="decrypt-password" placeholder="Inserisci chiave di accesso" style="width: 100%; padding: 12px 40px 12px 15px; border-radius: 4px; border: 1px solid rgba(0, 240, 255, 0.3); background: rgba(6, 10, 26, 0.8); color: #fff; font-size: 14px; outline: none; box-shadow: 0 0 10px rgba(0, 0, 0, 0.5); box-sizing: border-box;">
                <i class="fa-solid fa-key" style="position: absolute; right: 15px; top: 15px; color: rgba(0, 240, 255, 0.5);"></i>
            </div>
            <button id="btn-decrypt" style="width: 100%; padding: 12px; border-radius: 4px; border: none; background: linear-gradient(135deg, #00f0ff, #0072ff); color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; transition: all 0.3s; box-shadow: 0 0 15px rgba(0, 240, 255, 0.3);">
                DECIFRA E ACCEDI
            </button>
            <div id="decrypt-error" style="color: #ef4444; font-size: 12px; margin-top: 15px; display: none;">
                <i class="fa-solid fa-triangle-exclamation"></i> Chiave errata o dati corrotti.
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    const input = document.getElementById('decrypt-password');
    const button = document.getElementById('btn-decrypt');
    const errorEl = document.getElementById('decrypt-error');
    
    input.focus();
    
    button.onclick = async () => {
        const password = input.value.trim();
        if (!password) return;
        
        button.disabled = true;
        button.innerText = 'DECRITTOGRAFIA IN CORSO...';
        errorEl.style.display = 'none';
        
        try {
            await onSuccess(password);
            overlay.remove(); // Successo! Rimuovi l'overlay di sblocco
        } catch (err) {
            console.error("Errore decrittografia:", err);
            errorEl.style.display = 'block';
            button.disabled = false;
            button.innerText = 'DECIFRA E ACCEDI';
            input.value = '';
            input.focus();
        }
    };
    
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            button.click();
        }
    });
}


// 3. RENDER DATA AGGIORNAMENTO
function renderLastUpdated(timeStr) {
    document.getElementById('last-updated-time').innerText = timeStr;
}

// 4. RENDER WARNING MATRIX
function renderWarningMatrix(matrix) {
    for (const [key, val] of Object.entries(matrix)) {
        const itemEl = document.getElementById(`trigger-${key}`);
        if (itemEl) {
            // Rimuoviamo classi precedenti
            itemEl.classList.remove('green', 'yellow', 'red', 'gray', 'clickable');
            
            // Assegniamo stato
            const statusClass = val.status.toLowerCase(); // green / yellow / red / gray
            itemEl.classList.add(statusClass);

            // Rendiamo sempre cliccabile per visualizzare i dettagli (se c'è una descrizione o un file)
            if (val.detail || val.filename) {
                itemEl.classList.add('clickable');
                itemEl.title = `Clicca per aprire la valutazione di scenario: ${val.filename || ''}`;
                itemEl.onclick = () => {
                    openWarningMatrixDetailModal(key, val);
                };
            } else {
                // Anche in stato GRAY senza dettagli forniamo una spiegazione al click
                itemEl.classList.add('clickable');
                itemEl.title = `Nessun dettaglio disponibile`;
                itemEl.onclick = () => {
                    openWarningMatrixDetailModal(key, val);
                };
            }
        }
    }
}

// Helper per ottenere le navi spuntate nel dropdown
function getSelectedShips() {
    const checkboxes = document.querySelectorAll('#ship-checkboxes-container input[type="checkbox"]');
    const selected = [];
    checkboxes.forEach(cb => {
        if (cb.checked) {
            selected.push(cb.value);
        }
    });
    return selected;
}

// 5. RENDER NAVI ONG SULLA MAPPA
function renderShipsOnMap(ships) {
    // Pulisci marker precedenti
    shipsLayer.clearLayers();

    if (!ships || ships.length === 0) {
        console.warn("Nessuna nave ONG tracciata.");
        return;
    }

    // Popola il menu multiselect la prima volta che abbiamo dei dati
    populateShipDropdown(ships);

    // Controlla quali navi sono selezionate
    const checkboxes = document.querySelectorAll('#ship-checkboxes-container input[type="checkbox"]');
    const selectedShips = getSelectedShips();
    const filterActive = checkboxes.length > 0;

    const filteredShips = ships.filter(ship => {
        if (!filterActive) return true;
        return selectedShips.includes(ship.name);
    });

    filteredShips.forEach(ship => {
        if (!ship.lat || !ship.lon) return;

        // Determina il colore del cerchio in base allo stato
        const isMoving = ship.sog > 0.5;
        const color = isMoving ? '#10b981' : '#f59e0b'; // Verde in movimento, giallo fermo

        // Marker a cerchio luminoso
        const marker = L.circleMarker([ship.lat, ship.lon], {
            radius: 8,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 0.9,
            fillOpacity: 0.9
        });

        // Costruisce la sezione cronologia — tutti i record espansi, con scroll abilitato via disableScrollPropagation
        const historyEntries = (ship.history && ship.history.length > 0)
            ? ship.history
            : [{ lat: ship.lat, lon: ship.lon, sog: ship.sog, cog: ship.cog, timestamp: ship.timestamp }];

        const historyHtml = `
            <div style="margin-top: 10px; font-weight: 700; font-size: 0.72rem; border-top: 1px solid rgba(0,229,255,0.15); padding-top: 6px; color: #00e5ff;">
                📋 Cronologia Rilevamenti (${historyEntries.length})
            </div>
            <div class="ship-history-scroll" style="max-height: 150px; overflow-y: scroll; font-size: 0.68rem; color: #a4b0be; margin-top: 4px; padding-right: 2px;">
                ${historyEntries.map((h, i) => `
                    <div style="border-bottom: 1px solid rgba(255,255,255,0.07); padding: 5px 0; line-height: 1.5;">
                        <div style="color: ${i === 0 ? '#00e5ff' : '#cdd6f4'}; font-weight: 600;">${i === 0 ? '📍' : '📅'} ${h.timestamp} UTC</div>
                        <div>Lat: ${parseFloat(h.lat).toFixed(5)}, Lon: ${parseFloat(h.lon).toFixed(5)}</div>
                        <div>Vel: <strong>${h.sog}</strong> nodi &nbsp;|&nbsp; Rotta: <strong>${h.cog}°</strong></div>
                    </div>
                `).join('')}
            </div>
        `;

        // Crea popup HTML premium
        const popupContent = `
            <div class="map-popup" style="min-width: 200px;">
                <h4><i class="fa-solid fa-ship"></i> ${ship.name}</h4>
                <p><strong>MMSI:</strong> ${ship.mmsi}</p>
                <p><strong>Stato:</strong> ${isMoving ? '🟢 In Movimento' : '⚠️ Fermo / Drifting'}</p>
                <p><strong>Velocità:</strong> ${ship.sog} nodi</p>
                <p><strong>Rotta:</strong> ${ship.cog}°</p>
                <p><strong>Posizione:</strong> ${ship.lat.toFixed(4)}, ${ship.lon.toFixed(4)}</p>
                <p class="popup-time"><i class="fa-solid fa-clock"></i> ${ship.timestamp} UTC</p>
                ${historyHtml}
            </div>
        `;

        marker.bindPopup(popupContent, {
            className: 'custom-leaflet-popup',
            maxWidth: 280,
            maxHeight: 420
        });

        // Abilita lo scroll interno nel div cronologia senza muovere la mappa
        marker.on('popupopen', function() {
            const scrollDiv = document.querySelector('.ship-history-scroll');
            if (scrollDiv) {
                L.DomEvent.disableScrollPropagation(scrollDiv);
                // Touch scroll su iOS/Android
                scrollDiv.style.webkitOverflowScrolling = 'touch';
                scrollDiv.style.overflowY = 'scroll';
            }
        });

        shipsLayer.addLayer(marker);
    });

    // Se ci sono navi visualizzate, inquadriamole — ma restando ancorati
    // al Mediterraneo Centrale (teatro operativo Libia/Tunisia/Sicilia).
    // Evita che una singola nave in un porto lontano zoomi su tutta l'Europa.
    const MED_BOUNDS = L.latLngBounds([[30.5, 8.0], [39.5, 22.0]]);
    if (filteredShips.length > 0) {
        const group = new L.featureGroup(shipsLayer.getLayers());
        const shipBounds = group.getBounds();
        if (MED_BOUNDS.contains(shipBounds)) {
            map.fitBounds(shipBounds.pad(0.25), { maxZoom: 8 });
        } else {
            // Navi fuori dal teatro: manteniamo la vista sul Mediterraneo Centrale
            map.fitBounds(MED_BOUNDS, { maxZoom: 7 });
        }
    } else {
        map.fitBounds(MED_BOUNDS, { maxZoom: 7 });
    }
}

// Popolamento dinamico delle checkbox delle navi
function populateShipDropdown(ships) {
    const container = document.getElementById('ship-checkboxes-container');
    if (!container) return;

    // Evitiamo di ripopolare se la lista è già presente e completa
    const currentCount = container.querySelectorAll('input[type="checkbox"]').length;
    const uniqueShipNames = [...new Set(ships.map(s => s.name))].sort();

    if (currentCount === uniqueShipNames.length) {
        return; // Già popolato correttamente
    }

    container.innerHTML = '';

    uniqueShipNames.forEach(name => {
        const label = document.createElement('label');
        label.className = 'dropdown-option';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = name;
        input.checked = true; // Tutte spuntate inizialmente

        input.addEventListener('change', () => {
            updateSelectAllState();
            if (dbData) {
                renderShipsOnMap(dbData.ngo_ships);
            }
        });

        const span = document.createElement('span');
        span.innerText = name;

        label.appendChild(input);
        label.appendChild(span);
        container.appendChild(label);
    });

    // Configura checkbox "Seleziona tutte"
    const selectAll = document.getElementById('ship-select-all');
    if (selectAll) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
        
        // Rimuove eventuali listener precedenti riassegnando l'onclick
        selectAll.onclick = function() {
            const state = selectAll.checked;
            const checkboxes = container.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = state;
            });
            if (dbData) {
                renderShipsOnMap(dbData.ngo_ships);
            }
        };
    }
}

// Aggiorna lo stato di "Seleziona tutte" (incluso lo stato indeterminato)
function updateSelectAllState() {
    const selectAll = document.getElementById('ship-select-all');
    const container = document.getElementById('ship-checkboxes-container');
    if (!selectAll || !container) return;

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const checkedBoxes = container.querySelectorAll('input[type="checkbox"]:checked');

    if (checkedBoxes.length === checkboxes.length) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
    } else if (checkedBoxes.length === 0) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    } else {
        selectAll.checked = false;
        selectAll.indeterminate = true; // Stato parzialmente selezionato
    }
}

// 6. RENDER GRAFICO TREND GDELT
function renderChart(history) {
    const ctx = document.getElementById('gdeltChart').getContext('2d');
    
    // Trova la prima data utile presente nelle note del wiki validate
    let minWikiDate = null;
    if (dbData && dbData.notes) {
        dbData.notes.forEach(note => {
            if (note.date) {
                const dateMatch = String(note.date).match(/^\d{4}-\d{2}-\d{2}/);
                if (dateMatch) {
                    const dStr = dateMatch[0];
                    if (!minWikiDate || dStr < minWikiDate) {
                        minWikiDate = dStr;
                    }
                }
            }
        });
    }

    // Filtra la history a partire dal primo dato wiki utile
    let filteredHistory = history;
    if (minWikiDate) {
        filteredHistory = history.filter(r => r.Date >= minWikiDate);
    }

    // Applica la finestra temporale (time-window selector)
    if (currentTimeWindow !== null) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - currentTimeWindow);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        filteredHistory = filteredHistory.filter(r => r.Date >= cutoffStr);
    }

    // Troviamo tutte le date uniche ordinate sulla base dei dati filtrati
    const dates = [...new Set(filteredHistory.map(r => r.Date))].sort();
    gdeltChartDates = dates; // Salviamo globalmente per la heatmap ACLED

    // Regolazione dinamica della larghezza per evitare sovrapposizioni e migliorare la leggibilità mobile
    const scrollContent = document.querySelector('.chart-scroll-content');
    if (scrollContent) {
        const calculatedWidth = dates.length * 24; // 24px per giorno
        scrollContent.style.minWidth = `max(100%, ${calculatedWidth}px)`;
    }
    let datasets = [];

    if (currentCountryFilter === 'ALL') {
        // Linee separate per Libia (LY) e Tunisia (TS)
        // Palette ANALITICA coerente: il COLORE codifica la dimensione
        // (Disordini/Repressione/Vuoti), lo STILE della linea codifica il Paese
        // (Libia = continua, Tunisia = tratteggiata). Niente rosso/verde di stato.
        const countries = [
            { code: 'LY', name: 'Libia', colorUnrest: '#38bdf8', colorRep: '#c084fc', colorConf: '#fbbf24', dash: [] },
            { code: 'TS', name: 'Tunisia', colorUnrest: '#38bdf8', colorRep: '#c084fc', colorConf: '#fbbf24', dash: [6, 4] }
        ];

        countries.forEach(c => {
            const countryData = filteredHistory.filter(r => r.Country === c.code);
            const datasetUnrest = [];
            const datasetRepression = [];
            const datasetConflict = [];

            dates.forEach(date => {
                const unrestRecs = countryData.filter(r => r.Date === date && r.Dimension === 'Civil_Unrest');
                datasetUnrest.push(unrestRecs.length > 0 ? Math.max(...unrestRecs.map(r => r.Z_Score)) : 0);

                const repRecs = countryData.filter(r => r.Date === date && r.Dimension === 'State_Repression');
                datasetRepression.push(repRecs.length > 0 ? Math.max(...repRecs.map(r => r.Z_Score)) : 0);

                const confRecs = countryData.filter(r => r.Date === date && r.Dimension === 'Conflict_PowerVacuum');
                datasetConflict.push(confRecs.length > 0 ? Math.max(...confRecs.map(r => r.Z_Score)) : 0);
            });

            datasets.push({
                label: `${c.name} - Disordini`,
                data: datasetUnrest,
                borderColor: c.colorUnrest,
                borderDash: c.dash,
                borderWidth: 2,
                tension: 0.3,
                fill: false
            });

            datasets.push({
                label: `${c.name} - Repressione`,
                data: datasetRepression,
                borderColor: c.colorRep,
                borderDash: c.dash,
                borderWidth: 2,
                tension: 0.3,
                fill: false
            });

            datasets.push({
                label: `${c.name} - Vuoti di potere/Conflitti`,
                data: datasetConflict,
                borderColor: c.colorConf,
                borderDash: c.dash,
                borderWidth: 2,
                tension: 0.3,
                fill: false
            });
        });
    } else {
        // Visualizzazione di un singolo paese con area soft riempita
        const countryData = filteredHistory.filter(r => r.Country === currentCountryFilter);
        const countryName = currentCountryFilter === 'LY' ? 'Libia' : 'Tunisia';
        
        const datasetUnrest = [];
        const datasetRepression = [];
        const datasetConflict = [];

        dates.forEach(date => {
            const unrestRecs = countryData.filter(r => r.Date === date && r.Dimension === 'Civil_Unrest');
            datasetUnrest.push(unrestRecs.length > 0 ? Math.max(...unrestRecs.map(r => r.Z_Score)) : 0);

            const repRecs = countryData.filter(r => r.Date === date && r.Dimension === 'State_Repression');
            datasetRepression.push(repRecs.length > 0 ? Math.max(...repRecs.map(r => r.Z_Score)) : 0);

            const confRecs = countryData.filter(r => r.Date === date && r.Dimension === 'Conflict_PowerVacuum');
            datasetConflict.push(confRecs.length > 0 ? Math.max(...confRecs.map(r => r.Z_Score)) : 0);
        });

        datasets = [
            {
                label: `Disordini Civili (${countryName})`,
                data: datasetUnrest,
                borderColor: '#38bdf8',
                backgroundColor: 'rgba(56, 189, 248, 0.06)',
                borderWidth: 2,
                tension: 0.3,
                fill: true
            },
            {
                label: `Repressione Statale (${countryName})`,
                data: datasetRepression,
                borderColor: '#c084fc',
                backgroundColor: 'rgba(192, 132, 252, 0.06)',
                borderWidth: 2,
                tension: 0.3,
                fill: true
            },
            {
                label: `Vuoti di potere/Conflitti (${countryName})`,
                data: datasetConflict,
                borderColor: '#fbbf24',
                backgroundColor: 'rgba(251, 191, 36, 0.06)',
                borderWidth: 2,
                tension: 0.3,
                fill: true
            }
        ];
    }

    // Plugin inline: disegna i nomi dei mesi in trasparenza nell'area alta del grafico
    const monthLabelPlugin = {
        id: 'monthLabels',
        afterDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.x) return;

            const MESI_IT = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                             'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

            // Raggruppa le date per mese e trova il pixel centrale di ogni mese
            const monthGroups = {}; // 'YYYY-MM' -> [pixelX, ...]
            dates.forEach((dateStr, idx) => {
                const monthKey = dateStr.slice(0, 7); // 'YYYY-MM'
                const px = scales.x.getPixelForValue(idx);
                if (!monthGroups[monthKey]) monthGroups[monthKey] = [];
                monthGroups[monthKey].push(px);
            });

            ctx.save();
            ctx.font = 'bold 13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(148, 163, 184, 0.18)'; // Trasparenza alta

            Object.entries(monthGroups).forEach(([monthKey, pixels]) => {
                const avgPx = pixels.reduce((a, b) => a + b, 0) / pixels.length;
                // Disegna solo se abbastanza larghezza (>30px) per non sovrapporre etichette
                const spanPx = pixels[pixels.length - 1] - pixels[0];
                if (spanPx < 20 && Object.keys(monthGroups).length > 1) return;

                const monthIdx = parseInt(monthKey.slice(5, 7), 10) - 1;
                const monthName = MESI_IT[monthIdx];
                const year = monthKey.slice(0, 4);
                // Mostra l'anno solo per gennaio o se c'è un solo mese visibile
                const label = (monthIdx === 0 || Object.keys(monthGroups).length === 1)
                    ? `${monthName} ${year}`
                    : monthName;

                // Clip all'area del grafico per non sforare
                if (avgPx >= chartArea.left && avgPx <= chartArea.right) {
                    ctx.fillText(label, avgPx, chartArea.top + 6);
                }
            });
            ctx.restore();
        }
    };

    // Distruggi il grafico esistente se c'è
    if (gdeltChart) {
        gdeltChart.destroy();
    }

    const isMobile = window.innerWidth <= 768;

    // Configura e crea il grafico Chart.js
    gdeltChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates.map(d => formatDateStr(d)),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#94a3b8',
                        font: { size: isMobile ? 8 : 10, family: 'Inter' }
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            onClick: (evt, elements) => {
                if (!elements.length) return;
                const idx = elements[0].index;
                const date = dates[idx];
                const spikes = dbData.gdelt_spike_details || {};
                const matchingSpike = Object.values(spikes).find(s => s.date === date);
                if (matchingSpike) {
                    showGdeltModal(matchingSpike);
                } else {
                    const available = Object.values(spikes).filter(s => s.date <= date).sort((a,b) => b.date.localeCompare(a.date));
                    if (available.length) showGdeltModal(available[0]);
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.02)' },
                    ticks: {
                        color: '#64748b',
                        font: { size: isMobile ? 8 : 9 },
                        minRotation: 90,
                        maxRotation: 90
                    }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#64748b' },
                    title: {
                        display: !isMobile,
                        text: 'Z-Score (Soglia Allerta = 1.5)',
                        color: '#64748b',
                        font: { size: 10 }
                    }
                }
            }
        },
        plugins: [monthLabelPlugin]
    });
}

// =============================================================================
// 7b. ACLED HEATMAP STRIP — Centrata al pixel sotto l'asse X del grafico GDELT
//     Ogni mattoncino è centrato esattamente sotto il tick del giorno corrispondente:
//     left = pixel(giorno) - halfStep, right = pixel(giorno) + halfStep.
// =============================================================================
function renderAcledHeatmap(acledHistory) {
    const container = document.getElementById('acled-heatmap');
    if (!container) return;
    container.innerHTML = '';

    if (!gdeltChart || !gdeltChart.scales || !gdeltChart.scales.x || !gdeltChartDates.length) return;

    const xScale     = gdeltChart.scales.x;
    const chartArea  = gdeltChart.chartArea;
    const chartLeft  = chartArea.left;
    const chartRight = chartArea.right;

    // Costruiamo un indice date GDELT → indice per lookup O(1)
    const dateToIndex = {};
    gdeltChartDates.forEach((d, i) => { dateToIndex[d] = i; });

    // Funzione: converte una data YYYY-MM-DD nel pixel X esatto
    function dateToPixel(dateStr) {
        const idx = dateToIndex[dateStr];
        if (idx !== undefined) {
            return xScale.getPixelForValue(idx);
        }
        return chartRight;
    }

    container.style.position = 'relative';
    container.style.height   = '42px';

    // Costruiamo una mappa degli eventi ACLED indicizzata per giorno (YYYY-MM-DD)
    const acledMap = {};
    if (acledHistory && acledHistory.length > 0) {
        acledHistory.forEach(day => {
            acledMap[day.week] = day; // day.week in realtà contiene la data giornaliera 'YYYY-MM-DD'
        });
    }

    // Funzione helper per formattare YYYY-MM-DD in GG-MM-AAAA
    function formatDateToIT(dateStr) {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        return dateStr;
    }

    // Funzione helper per generare un colore HSL pulito e chiaro in base al livello di severità
    function getSeverityColor(norm) {
        if (norm <= 0.05) {
            return {
                bg: '#1e293b',
                border: '#334155'
            };
        }
        
        // Gradiente: Giallo (allerta bassa) -> Arancione (allerta media) -> Rosso fuoco (allerta alta)
        const hue = Math.round(58 - (norm * 58));
        const sat = Math.round(75 + (norm * 15)); 
        const light = Math.round(44 - (norm * 8)); 
        
        return {
            bg: `hsl(${hue}, ${sat}%, ${light}%)`,
            border: `hsl(${hue}, ${sat}%, ${light + 8}%)`
        };
    }

    // Calcoliamo il mezzo passo (halfStep) tra due tick adiacenti.
    // Ogni mattoncino verrà centrato esattamente sotto il proprio tick:
    //   left = pixel(idx) - halfStep
    //   right = pixel(idx) + halfStep
    let halfStep;
    if (gdeltChartDates.length >= 2) {
        halfStep = (dateToPixel(gdeltChartDates[1]) - dateToPixel(gdeltChartDates[0])) / 2;
    } else {
        halfStep = (chartRight - chartLeft) / 2;
    }

    // Disegnamo un mattoncino per ciascun giorno visualizzato nel grafico
    gdeltChartDates.forEach((dateStr, idx) => {
        const dayData = acledMap[dateStr] || {
            week: dateStr,
            total_events: 0,
            total_fatalities: 0,
            severity_norm: 0,
            events: []
        };

        const center = dateToPixel(dateStr);
        const pxStart = Math.max(center - halfStep, chartLeft);
        const pxEnd   = Math.min(center + halfStep, chartRight);

        const blockW = pxEnd - pxStart;
        if (blockW <= 0.5) return;

        const norm = dayData.severity_norm || 0;
        const colorSet = getSeverityColor(norm);
        const hasEvents = dayData.total_events > 0;

        const block = document.createElement('div');
        block.style.cssText = `
            position: absolute;
            left: ${pxStart}px;
            width: ${blockW}px;
            height: 100%;
            background: ${colorSet.bg};
            border-right: 1px solid ${colorSet.border};
            border-top: 1px solid ${colorSet.border};
            border-bottom: 1px solid ${colorSet.border};
            ${idx === 0 ? 'border-left: 1px solid ' + colorSet.border + ';' : ''}
            border-radius: ${idx === 0 ? '3px' : '0'} ${idx === gdeltChartDates.length - 1 ? '3px 3px' : '0 0'} ${idx === 0 ? '3px' : '0'};
            cursor: ${hasEvents ? 'pointer' : 'default'};
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            box-sizing: border-box;
            transition: opacity 0.12s, transform 0.12s;
        `;

        const dateFormatted = formatDateToIT(dateStr);
        if (hasEvents) {
            block.title = `Giorno: ${dateFormatted}\nEventi ACLED: ${dayData.total_events} | Vittime: ${dayData.total_fatalities}\nSeverità: ${Math.round(norm * 100)}%`;
            
            // Mostriamo la label con la data solo se il blocco è largo (>60px)
            if (blockW > 60) {
                const label = document.createElement('span');
                label.style.cssText = 'font-size:0.52rem;color:rgba(255,255,255,0.9);pointer-events:none;white-space:nowrap;letter-spacing:0.02em;font-weight:700;text-shadow: 0 1px 2px rgba(0,0,0,0.6);';
                label.textContent = dateFormatted;
                block.appendChild(label);
            }

            block.addEventListener('mouseenter', () => {
                block.style.opacity = '0.85';
                block.style.transform = 'scaleY(1.12) translateY(-1px)';
            });
            block.addEventListener('mouseleave', () => {
                block.style.opacity = '1';
                block.style.transform = 'scaleY(1)';
            });
            block.addEventListener('click', () => showAcledModal(dayData));
        } else {
            block.title = `Giorno: ${dateFormatted}\nNessun evento ACLED registrato`;
        }

        container.appendChild(block);
    });
}


// =============================================================================
// 7c. MODAL: Dettaglio spike GDELT
// =============================================================================
function showGdeltModal(spike) {
    const DIM_LABELS = {
        'Civil_Unrest': '🟡 Disordini Civili',
        'State_Repression': '🔴 Repressione Statale',
        'Conflict_PowerVacuum': '🔴 Vuoti di Potere / Conflitti'
    };
    const COUNTRY_LABELS = { 'LY': '🇱🇾 Libia', 'TS': '🇹🇳 Tunisia' };

    document.getElementById('gdelt-modal-title').textContent =
        `Spike GDELT — ${COUNTRY_LABELS[spike.country] || spike.country} — ${spike.date}`;

    document.getElementById('gdelt-modal-meta').innerHTML = `
        <span class="modal-meta-badge badge-red">Z-Score: ${spike.z_score.toFixed(2)}</span>
        <span class="modal-meta-badge badge-blue">${DIM_LABELS[spike.dimension] || spike.dimension}</span>
        <span class="modal-meta-badge badge-gray">Articoli rilevati: ${spike.event_count}</span>
    `;

    const tbody = document.getElementById('gdelt-modal-tbody');
    tbody.innerHTML = '';
    (spike.events || []).forEach(ev => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${ev.actor || '—'}</strong></td>
            <td>${ev.action || '—'}</td>
            <td>${ev.location || '—'}</td>
            <td class="mono">${ev.coords || '—'}</td>
            <td class="text-center">${ev.mentions}</td>
            <td><a href="${ev.url}" target="_blank" rel="noopener" class="intel-link">🔗 Apri</a></td>
        `;
        tbody.appendChild(tr);
    });

    if (!spike.events || spike.events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:#4a5568">Nessun dettaglio disponibile per questa data</td></tr>';
    }

    const modal = document.getElementById('gdelt-modal');
    modal.style.display = 'flex';
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
}

// =============================================================================
// 7d. MODAL: Dettaglio settimana ACLED
// =============================================================================
function showAcledModal(dayData) {
    // Formatta la data YYYY-MM-DD in GG-MM-AAAA
    let dateStr = dayData.week; // YYYY-MM-DD
    let dateFormatted = dateStr;
    if (dateStr) {
        const parts = dateStr.split('-');
        if (parts.length === 3) dateFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
    }

    document.getElementById('acled-modal-title').textContent =
        `ACLED — Dettaglio del ${dateFormatted}`;

    const severityPct = Math.round((dayData.severity_norm || 0) * 100);
    const level = severityPct > 60 ? '🔴 ALTA' : severityPct > 30 ? '🟡 MEDIA' : '🟢 BASSA';
    document.getElementById('acled-modal-meta').innerHTML = `
        <span class="modal-meta-badge badge-red">Intensità: ${level} (${severityPct}%)</span>
        <span class="modal-meta-badge badge-gray">Eventi: ${dayData.total_events}</span>
        <span class="modal-meta-badge badge-orange">Vittime: ${dayData.total_fatalities}</span>
    `;

    const container = document.getElementById('acled-modal-events-container');
    if (!container) return;
    container.innerHTML = '';

    const EVENT_COLORS = {
        'Battles': '#ef4444',
        'Explosions/Remote violence': '#f97316',
        'Violence against civilians': '#dc2626',
        'Riots': '#f59e0b',
        'Protests': '#3b82f6',
        'Strategic developments': '#6b7280'
    };

    // Filtra la lista ricca globale di tutti gli eventi georeferenziati caricati (dbData.acled_events)
    // per visualizzare i dettagli completi degli eventi di questa data
    const targetDate = dayData.week;
    const detailedEvents = (dbData.acled_events || []).filter(ev => {
        if (ev.date !== targetDate) return false;
        if (currentCountryFilter === 'LY' && ev.country !== 'Libya') return false;
        if (currentCountryFilter === 'TS' && ev.country !== 'Tunisia') return false;
        return true;
    });

    if (detailedEvents.length > 0) {
        detailedEvents.forEach(ev => {
            const color = EVENT_COLORS[ev.type] || '#6b7280';
            const card = document.createElement('div');
            card.className = 'acled-event-card';
            card.style.borderLeftColor = color;
            
            card.innerHTML = `
                <div class="acled-event-card-header">
                    <span class="acled-event-card-title" style="color:${color}">${ev.type}</span>
                    <span class="acled-event-card-date">${dateFormatted}</span>
                </div>
                <div class="acled-event-card-detail"><strong>Localizzazione:</strong> ${ev.location}, ${ev.admin1} (${ev.country})</div>
                <div class="acled-event-card-detail"><strong>Dettaglio:</strong> ${ev.sub_type || 'N/A'}</div>
                <div class="acled-event-card-detail"><strong>Attori:</strong> ${ev.actor1} ${ev.actor2 ? 'vs ' + ev.actor2 : ''}</div>
                <div class="acled-event-card-detail"><strong>Vittime stimate:</strong> <span class="${ev.fatalities > 0 ? 'text-danger' : 'text-success'}" style="font-weight:700">${ev.fatalities}</span></div>
                ${ev.notes ? `<div class="acled-event-card-notes">"${ev.notes}"</div>` : ''}
                <div style="margin-top:6px;font-size:0.65rem;color:#64748b;text-align:right">Fonte: ${ev.source}</div>
            `;
            container.appendChild(card);
        });
    } else {
        // Fallback: se non abbiamo dettagli georeferenziati, mostriamo le righe aggregate da dayData.events
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'intel-table-wrapper';
        
        const table = document.createElement('table');
        table.className = 'intel-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Paese</th>
                    <th>Area</th>
                    <th>Tipo Evento</th>
                    <th>Sub-Evento</th>
                    <th>N. Eventi</th>
                    <th>Vittime</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        
        const tbody = table.querySelector('tbody');
        (dayData.events || []).forEach(ev => {
            const color = EVENT_COLORS[ev.event_type] || '#6b7280';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${ev.country}</td>
                <td>${ev.area}</td>
                <td><span class="event-type-badge" style="border-left:3px solid ${color};padding-left:6px">${ev.event_type}</span></td>
                <td>${ev.sub_event}</td>
                <td class="text-center">${ev.n_events}</td>
                <td class="text-center ${ev.fatalities > 0 ? 'text-danger' : ''}">${ev.fatalities > 0 ? ev.fatalities : '0'}</td>
            `;
            tbody.appendChild(tr);
        });
        
        tableWrapper.appendChild(table);
        container.appendChild(tableWrapper);
    }

    const modal = document.getElementById('acled-modal');
    modal.style.display = 'flex';
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
}

// =============================================================================
// 7e. LAYER ACLED sulla mappa Leaflet (ultima settimana)
// =============================================================================
let acledLayer = null;
let acledLayerControl = null;

// Lookup coordinate approssimative per area ACLED
const ACLED_COORDS = {
    // Libya
    'Libya|West':  { lat: 32.89, lon: 13.18 },   // Tripoli area
    'Libya|East':  { lat: 32.11, lon: 20.07 },   // Benghazi area
    'Libya|South': { lat: 27.04, lon: 14.43 },   // Fezzan
    // Tunisia
    'Tunisia|Tunis':      { lat: 36.82, lon: 10.17 },
    'Tunisia|Sfax':       { lat: 34.74, lon: 10.76 },
    'Tunisia|Gafsa':      { lat: 34.43, lon: 8.78 },
    'Tunisia|Kasserine':  { lat: 35.17, lon: 8.83 },
    'Tunisia|Sidi Bouzid':{ lat: 35.04, lon: 9.49 },
    'Tunisia|Medenine':   { lat: 33.35, lon: 10.51 },
    'Tunisia|Tataouine':  { lat: 32.93, lon: 10.45 },
    'Tunisia|Kebili':     { lat: 33.70, lon: 8.97 },
    'Tunisia|Gabes':      { lat: 33.88, lon: 10.10 },
    'Tunisia|Nabeul':     { lat: 36.45, lon: 10.74 },
    'Tunisia|Sousse':     { lat: 35.83, lon: 10.64 },
    'Tunisia|Bizerte':    { lat: 37.27, lon: 9.87 },
    'Tunisia|Kairouan':   { lat: 35.68, lon: 10.10 },
    'Tunisia|Jendouba':   { lat: 36.50, lon: 8.78 },
    'Tunisia|Siliana':    { lat: 36.09, lon: 9.37 },
    'Tunisia|Beja':       { lat: 36.73, lon: 9.18 },
    'Tunisia|Mahdia':     { lat: 35.50, lon: 11.07 },
    'Tunisia|Manubah':    { lat: 36.80, lon: 10.09 },
    'Tunisia|Tozeur':     { lat: 33.92, lon: 8.13 },
};

const EVENT_RADIUS = {
    'Battles': 10,
    'Explosions/Remote violence': 10,
    'Violence against civilians': 8,
    'Riots': 7,
    'Protests': 5,
    'Strategic developments': 4
};

const EVENT_FILL = {
    'Battles': '#ef4444',
    'Explosions/Remote violence': '#f97316',
    'Violence against civilians': '#dc2626',
    'Riots': '#f59e0b',
    'Protests': '#3b82f6',
    'Strategic developments': '#6b7280'
};

let acledLegendControl = null;

function initAcledMapLayer(acledEvents) {
    if (!map) return;

    // Rimuovi layer precedente se esiste
    if (acledLayer) {
        map.removeLayer(acledLayer);
        acledLayer = null;
    }
    if (acledLayerControl) {
        acledLayerControl.remove();
        acledLayerControl = null;
    }
    if (acledLegendControl) {
        acledLegendControl.remove();
        acledLegendControl = null;
    }

    if (!acledEvents || acledEvents.length === 0) return;

    acledLayer = L.layerGroup();

    const EVENT_FILL_MAP = {
        'Battles': '#ef4444',                       // Rosso acceso
        'Explosions/Remote violence': '#f97316',     // Arancione
        'Violence against civilians': '#dc2626',     // Rosso scuro
        'Riots': '#f59e0b',                          // Giallo ambra
        'Protests': '#3b82f6',                       // Blu
        'Strategic developments': '#6b7280'          // Grigio
    };

    let addedCount = 0;

    acledEvents.forEach(ev => {
        // Applica il filtro paese della dashboard
        if (currentCountryFilter === 'LY' && ev.country !== 'Libya') return;
        if (currentCountryFilter === 'TS' && ev.country !== 'Tunisia') return;

        const lat = parseFloat(ev.lat);
        const lon = parseFloat(ev.lon);
        if (!lat || !lon) return;

        // Piccolo jitter per evitare sovrapposizioni millimetriche in città identiche
        const jitterLat = (Math.random() - 0.5) * 0.008;
        const jitterLon = (Math.random() - 0.5) * 0.008;

        const radius = 6 + Math.min(ev.fatalities * 1.5, 12);
        const color = EVENT_FILL_MAP[ev.type] || '#6b7280';

        // Formatta la data
        let dateFormatted = ev.date;
        if (dateFormatted) {
            const parts = dateFormatted.split('-');
            if (parts.length === 3) dateFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
        }

        const marker = L.circleMarker([lat + jitterLat, lon + jitterLon], {
            radius: radius,
            color: color,
            fillColor: color,
            fillOpacity: 0.55,
            weight: 1.5,
            opacity: 0.9
        });

        marker.bindPopup(`
            <div style="font-family:Inter,sans-serif;font-size:0.78rem;min-width:240px;max-width:300px;color:#f8fafc;padding:2px;">
                <div style="display:flex;justify-content:between;border-bottom:1px solid #334155;padding-bottom:4px;margin-bottom:6px;">
                    <span style="color:#ef4444;font-weight:700;">ACLED Event</span>
                    <span style="color:#94a3b8;margin-left:auto">${dateFormatted}</span>
                </div>
                <div><strong>Località:</strong> ${ev.location}, ${ev.admin1} (${ev.country})</div>
                <div style="margin-top:4px;"><strong>Tipo:</strong> <span style="color:${color};font-weight:600;">${ev.type}</span> (${ev.sub_type})</div>
                <div style="margin-top:2px;"><strong>Attori:</strong> <span style="color:#cbd5e1">${ev.actor1}</span> vs <span style="color:#cbd5e1">${ev.actor2}</span></div>
                <div style="margin-top:2px;"><strong>Vittime stimate:</strong> <span style="color:${ev.fatalities > 0 ? '#f87171' : '#10b981'};font-weight:700;">${ev.fatalities}</span></div>
                <div style="margin-top:6px;padding:6px;background:#0f172a;border-radius:4px;font-style:italic;color:#cbd5e1;line-height:1.2;font-size:0.72rem;border-left:2px solid ${color}">
                    "${ev.notes}"
                </div>
                <div style="margin-top:4px;font-size:0.65rem;color:#64748b;text-align:right">Fonte: ${ev.source}</div>
            </div>
        `, { className: 'custom-leaflet-popup', maxWidth: 300 });

        marker.addTo(acledLayer);
        addedCount++;
    });

    // Aggiungiamo il layer solo se ci sono marker filtrati e se la checkbox nativa è attiva
    const toggleEl = document.getElementById('map-acled-toggle');
    const isChecked = toggleEl ? toggleEl.checked : true;

    if (addedCount > 0) {
        if (isChecked) {
            acledLayer.addTo(map);
        }

        // Popola la legenda statica sotto la mappa se attiva
        const legendEl = document.getElementById('acled-map-legend');
        if (legendEl) {
            legendEl.style.display = isChecked ? 'flex' : 'none';
            legendEl.innerHTML = `
                <div class="map-legend-item"><span class="map-legend-color" style="background:#ef4444;"></span>Scontri</div>
                <div class="map-legend-item"><span class="map-legend-color" style="background:#dc2626;"></span>Violenza vs Civili</div>
                <div class="map-legend-item"><span class="map-legend-color" style="background:#f97316;"></span>Esplosioni</div>
                <div class="map-legend-item"><span class="map-legend-color" style="background:#f59e0b;"></span>Rivolte</div>
                <div class="map-legend-item"><span class="map-legend-color" style="background:#3b82f6;"></span>Proteste</div>
                <div class="map-legend-item"><span class="map-legend-color" style="background:#6b7280;"></span>Sviluppi Strategici</div>
            `;
        }
    } else {
        // Nascondi la legenda se non ci sono eventi
        const legendEl = document.getElementById('acled-map-legend');
        if (legendEl) {
            legendEl.style.display = 'none';
        }
    }
}

// 7. RENDER TIMELINE EVENTI WIKI
function renderTimeline(notes) {
    const timelineEl = document.getElementById('timeline-events');
    const searchVal = document.getElementById('search-input').value.toLowerCase();
    const typeFilter = document.getElementById('type-filter').value;

    timelineEl.innerHTML = '';

    // Filtriamo le note
    let filteredNotes = notes.filter(note => {
        // Filtro di ricerca testuale
        const matchSearch = note.title.toLowerCase().includes(searchVal) || 
                            note.body.toLowerCase().includes(searchVal) ||
                            note.tags.some(t => t.toLowerCase().includes(searchVal));
        
        // Filtro tipo (EWS vs News)
        let matchType = true;
        const noteTags = note.tags.map(t => t.toLowerCase());
        const isEwsSensor = noteTags.some(t => ['ews', 'gdelt', 'unhcr', '4mi', 'dtm', 'frontex'].includes(t)) || note.filename.includes('EWS');
        const isNews = noteTags.some(t => ['socmint', 'news', 'proteste', 'migranti', 'cronaca'].includes(t)) || !isEwsSensor;
        
        if (typeFilter === 'ews') {
            matchType = isEwsSensor;
        } else if (typeFilter === 'news') {
            matchType = isNews && !isEwsSensor; // Escludiamo i sensori puri dalle news
        }

        // Filtro temporale (normalizzazione robusta YYYY-MM-DD con Flatpickr global variables)
        let matchDate = true;
        let noteDateClean = null;
        
        if (note.date) {
            const dateMatch = String(note.date).match(/^\d{4}-\d{2}-\d{2}/);
            if (dateMatch) {
                noteDateClean = dateMatch[0];
            }
        }

        if (noteDateClean) {
            if (startDateFilter && noteDateClean < startDateFilter) {
                matchDate = false;
            }
            if (endDateFilter && noteDateClean > endDateFilter) {
                matchDate = false;
            }
            // Se è selezionata solo una data (es. primo click su flatpickr), filtriamo per corrispondenza esatta di quel giorno
            if (startDateFilter && !endDateFilter && noteDateClean !== startDateFilter) {
                matchDate = false;
            }
        } else if (startDateFilter || endDateFilter) {
            // Nota senza data valida esclusa se il filtro temporale è attivo
            matchDate = false;
        }

        return matchSearch && matchType && matchDate;
    });

    if (filteredNotes.length === 0) {
        timelineEl.innerHTML = '<div class="loading-spinner">Nessuna nota trovata per i filtri selezionati.</div>';
        return;
    }

    filteredNotes.forEach(note => {
        // Determina classe in base al tipo
        const noteTags = note.tags.map(t => t.toLowerCase());
        const isEwsSensor = noteTags.some(t => ['ews', 'gdelt', 'unhcr', '4mi', 'dtm', 'frontex'].includes(t)) || note.filename.includes('EWS');
        const typeClass = isEwsSensor ? 'ews' : 'news';

        const itemEl = document.createElement('div');
        itemEl.className = `timeline-item ${typeClass}`;
        
        // Genera tag HTML
        let tagsHtml = '';
        note.tags.forEach(tag => {
            tagsHtml += `<span class="tag ${isEwsSensor ? 'tag-ews' : 'tag-news'}">${tag}</span>`;
        });

        itemEl.innerHTML = `
            <div class="timeline-marker"></div>
            <div class="timeline-content">
                <div class="timeline-meta">
                    <span><i class="fa-solid fa-calendar-days"></i> ${formatDateStr(note.date)}</span>
                    <span><i class="fa-solid fa-shield-halved"></i> ${note.admiralty}</span>
                </div>
                <h3 class="timeline-title">${note.title}</h3>
                <p class="timeline-preview">${note.preview}</p>
                <div class="tag-list">${tagsHtml}</div>
            </div>
        `;

        // Click per aprire la modale
        itemEl.addEventListener('click', () => {
            openNoteModal(note);
        });

        timelineEl.appendChild(itemEl);
    });
}

// 8. APERTURA MODALE DETTAGLI NOTA
function openNoteModal(note) {
    const modal = document.getElementById('note-modal');
    document.getElementById('modal-title').innerText = note.title;
    document.getElementById('modal-date').innerHTML = `<i class="fa-solid fa-calendar"></i> Data: ${formatDateStr(note.date)}`;
    document.getElementById('modal-admiralty').innerHTML = `<i class="fa-solid fa-shield-halved"></i> Admiralty: ${note.admiralty}`;
    document.getElementById('modal-sources').innerHTML = `<i class="fa-solid fa-link"></i> Fonti: ${note.sources}`;
    document.getElementById('modal-tipo').innerHTML = `<i class="fa-solid fa-tag"></i> Tipo: ${note.tipo}`;
    
    // Parsing elementare del markdown per renderlo leggibile
    document.getElementById('modal-body').innerHTML = simpleMarkdownParse(note.body);
    
    modal.classList.add('active');
}

// 9. CONFIGURAZIONE EVENT LISTENER
function setupEventListeners() {
    // Bottone Aggiorna (gestito in modo sicuro in caso di rimozione dal layout HTML)
    const btnRefresh = document.getElementById('btn-refresh');
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            loadData();
        });
    }

    // Filtri grafici per paese
    const countryTabs = document.querySelectorAll('.chart-filters .btn-tab');
    countryTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            countryTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentCountryFilter = tab.getAttribute('data-country');
            if (dbData) {
                renderChart(dbData.gdelt_history);
                // Re-allinea la heatmap ACLED al nuovo range del grafico
                renderAcledHeatmap(dbData.acled_history || []);
                // Rinfresca i marker ACLED sulla mappa filtrandoli per il nuovo paese
                initAcledMapLayer(dbData.acled_events || []);
            }
        });
    });

    // Selettore finestra temporale (time-window)
    setupTimeWindowListeners();

    // Filtri timeline: barra di ricerca
    document.getElementById('search-input').addEventListener('input', () => {
        if (dbData) {
            renderTimeline(dbData.notes);
        }
    });

    // Filtri timeline: select tipo
    document.getElementById('type-filter').addEventListener('change', () => {
        if (dbData) {
            renderTimeline(dbData.notes);
        }
    });

    // Toggle dropdown multiselect navi ONG
    const dropdownBtn = document.getElementById('ship-dropdown-btn');
    const dropdownContent = document.getElementById('ship-dropdown-content');

    if (dropdownBtn && dropdownContent) {
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdownContent.classList.toggle('show');
        });
    }

    // Reset mappa ONG (ripristina filtri e zoom iniziale)
    const mapResetBtn = document.getElementById('map-reset-btn');
    if (mapResetBtn) {
        mapResetBtn.addEventListener('click', () => {
            // Seleziona tutte le checkbox delle navi
            const checkboxes = document.querySelectorAll('#ship-checkboxes-container input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
            const selectAll = document.getElementById('ship-select-all');
            if (selectAll) selectAll.checked = true;

            // Reset toggle ACLED
            const acledToggle = document.getElementById('map-acled-toggle');
            if (acledToggle) acledToggle.checked = true;
            
            // Re-renderizza le navi e gli eventi ACLED (ripristina lo zoom iniziale)
            if (dbData) {
                renderShipsOnMap(dbData.ngo_ships);
                initAcledMapLayer(dbData.acled_events || []);
            }
        });
    }

    // Toggle eventi ACLED sulla mappa
    const mapAcledToggle = document.getElementById('map-acled-toggle');
    if (mapAcledToggle) {
        mapAcledToggle.addEventListener('change', () => {
            const isChecked = mapAcledToggle.checked;
            if (acledLayer) {
                if (isChecked) {
                    acledLayer.addTo(map);
                } else {
                    map.removeLayer(acledLayer);
                }
            }
            // Aggiorna visibilità della legenda
            const legendEl = document.getElementById('acled-map-legend');
            if (legendEl) {
                const hasEvents = acledLayer && acledLayer.getLayers && acledLayer.getLayers().length > 0;
                legendEl.style.display = (isChecked && hasEvents) ? 'flex' : 'none';
            }
        });
    }

    // Flatpickr gestisce autonomamente il callback onChange su #date-range

    // Chiusura Modale (supporto sia per la "X" che per il pulsante "Chiudi Dettaglio" nel footer)
    document.querySelectorAll('.close-modal, .close-modal-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('note-modal').classList.remove('active');
        });
    });

    // Tooltip informativi: al tap/click si aprono in-page con la grafica
    // del tooltip (funziona anche su touch, dove l'hover non esiste)
    document.querySelectorAll('.info-tooltip').forEach(tooltip => {
        tooltip.addEventListener('click', (e) => {
            e.stopPropagation(); // Evita di attivare il click sulla card sottostante
            const wasOpen = tooltip.classList.contains('tooltip-open');
            document.querySelectorAll('.info-tooltip.tooltip-open')
                .forEach(t => t.classList.remove('tooltip-open'));
            if (!wasOpen) tooltip.classList.add('tooltip-open');
        });
    });

    window.addEventListener('click', (e) => {
        const modal = document.getElementById('note-modal');
        if (e.target === modal) {
            modal.classList.remove('active');
        }
        
        // Chiudi dropdown navi se si clicca fuori
        if (dropdownContent && dropdownBtn && !dropdownContent.contains(e.target) && !dropdownBtn.contains(e.target)) {
            dropdownContent.classList.remove('show');
        }

        // Chiudi eventuali tooltip aperti al tap se si clicca fuori
        document.querySelectorAll('.info-tooltip.tooltip-open')
            .forEach(t => t.classList.remove('tooltip-open'));
    });
}

// UTILITY: FORMATTA DATA YYYY-MM-DD -> DD/MM/YYYY
function formatDateStr(dateStr) {
    if (!dateStr) return 'N/D';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
}

// UTILITY: PARSING ELEMENTARE MARKDOWN -> HTML
function simpleMarkdownParse(mdText) {
    if (!mdText) return '';
    
    let html = mdText;
    
    // Rimuovi eventuale frontmatter se presente nel corpo
    html = html.replace(/^---[\s\S]*?---/, '');

    // Converti titoli ### o ##
    html = html.replace(/^###\s+(.*)$/gmi, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.*)$/gmi, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.*)$/gmi, '<h1>$1</h1>');

    // Converti grassetti **testo**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Converti elenchi puntati - o *
    // Cerca linee che iniziano con "-" e le avvolge in <li>
    html = html.replace(/^\s*-\s+(.*)$/gmi, '<li>$1</li>');
    // Avvolge blocchi consecutivi di <li> in <ul>
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    // Pulizia di tag ul doppi consecutivi
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Converti ritorni a capo in paragrafi per linee vuote
    html = html.split('\n').map(line => {
        line = line.trim();
        if (line === '') return '';
        if (line.startsWith('<h') || line.startsWith('<ul') || line.startsWith('<li') || line.startsWith('</ul')) {
            return line;
        }
        return `<p>${line}</p>`;
    }).join('\n');

    // Risoluzione dei WikiLink [[Nota]] in testo evidenziato
    html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, noteName, linkText) => {
        const text = linkText || noteName;
        return `<span class="wikilink"><i class="fa-solid fa-link-slash"></i> ${text}</span>`;
    });

    return html;
}

// =============================================================================
// 7f. MODAL: Dettaglio valutazione di scenario Warning Matrix
// =============================================================================
function openWarningMatrixDetailModal(key, val) {
    const titleMap = {
        "ordine_pubblico": "Ordine Pubblico",
        "repressione_vuoti": "Repressione & Vuoti di Potere",
        "forze_sicurezza": "Forze di Sicurezza",
        "pressione_demografica": "Pressione Demografica",
        "push_factors": "Push Factors",
        "fronte_marittimo": "Fronte Marittimo"
    };

    const modal = document.getElementById('matrix-detail-modal');
    if (!modal) return;

    // Titolo dell'indicatore
    document.getElementById('matrix-modal-title').innerText = titleMap[key] || "Dettaglio Indicatore";

    // Impostazione dell'icona del codice colore a sinistra del titolo
    const iconContainer = document.getElementById('matrix-modal-icon');
    if (iconContainer) {
        if (val.status === 'RED') {
            iconContainer.innerText = '🔴';
        } else if (val.status === 'YELLOW') {
            iconContainer.innerText = '🟡';
        } else if (val.status === 'GREEN') {
            iconContainer.innerText = '🟢';
        } else {
            iconContainer.innerText = '⚪';
        }
    }

    // Aggiungo la data in alto a destra
    const dateContainer = document.getElementById('matrix-modal-date');
    if (dateContainer) {
        if (val.filename) {
            let dMatch = val.filename.match(/(\d{4}-\d{2}-\d{2})/);
            if (dMatch) {
                dateContainer.innerText = "aggiornato al " + dMatch[1];
            } else {
                dateContainer.innerText = "";
            }
        } else {
            dateContainer.innerText = "";
        }
    }

    // Svuotiamo il vecchio badge di stato per evitare doppioni
    const metaContainer = document.getElementById('matrix-modal-meta');
    if (metaContainer) {
        metaContainer.innerHTML = '';
    }

    // Contenuto descrittivo (usando renderMarkdown per convertire il corpo)
    const detailContainer = document.getElementById('matrix-modal-detail-text');
    if (val.detail) {
        detailContainer.innerHTML = simpleMarkdownParse(val.detail);
    } else {
        detailContainer.innerHTML = `<p style="color:#64748b; font-style:italic; text-align:center; padding: 20px 0;">Nessun report di allerta validato disponibile per questo indicatore.</p>`;
    }

    // Nascondiamo il link in calce, mantenendo il container vuoto
    const linkContainer = document.getElementById('matrix-modal-report-link-container');
    if (linkContainer) {
        linkContainer.innerHTML = '';
        linkContainer.style.display = 'none';
    }

    // Mostra la modale e gestisci la chiusura al click all'esterno
    modal.style.display = 'flex';
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.style.display = 'none';
    }, { once: true });
}

// =============================================================================
// 10. SELETTORE FINESTRA TEMPORALE (TIME-WINDOW)
// =============================================================================
function setupTimeWindowListeners() {
    const twBtns = document.querySelectorAll('.btn-time-window');
    twBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            twBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const val = btn.getAttribute('data-window');
            currentTimeWindow = val === 'all' ? null : parseInt(val, 10);

            if (dbData) {
                renderChart(dbData.gdelt_history);
                renderAcledHeatmap(dbData.acled_history || []);
                initAcledMapLayer(dbData.acled_events || []);
            }
        });
    });
}

// =====================================================================
// KNOWLEDGE GRAPH — Wiki
// =====================================================================

let wikiNetwork = null;
let wikiGraphData = null;

const WIKI_NODE_COLORS = {
    persona:        { bg: 'rgba(129,140,248,0.18)', border: '#818cf8', font: '#c7d2fe' }, // indigo
    organizzazione: { bg: 'rgba(52,211,153,0.15)',  border: '#34d399', font: '#a7f3d0' }, // emerald green
    location:       { bg: 'rgba(249,115,22,0.15)',   border: '#f97316', font: '#ffedd5' }, // deep orange
    agreement:      { bg: 'rgba(96,165,250,0.14)',  border: '#60a5fa', font: '#bfdbfe' }, // sky blue
    asset:          { bg: 'rgba(234,179,8,0.14)',   border: '#eab308', font: '#fef9c3' }, // gold yellow
    event:          { bg: 'rgba(239,68,68,0.14)',   border: '#ef4444', font: '#fee2e2' }, // fire red
    source:         { bg: 'rgba(168,85,247,0.14)',   border: '#a855f7', font: '#f3e8ff' }, // bright purple
    assertion:      { bg: 'rgba(148,163,184,0.1)',   border: '#64748b', font: '#94a3b8' }, // gray
    'wisdom-note':  { bg: 'rgba(236,72,153,0.12)',  border: '#ec4899', font: '#fbcfe8' }, // hot pink
};

const WIKI_NODE_ICONS = {
    persona: '\uf007',
    organizzazione: '\uf1ad',
    location: '\uf3c5',
    agreement: '\uf15c',
    asset: '\uf21a',
    event: '\uf0e7',
    source: '\uf1ea',
    assertion: '\uf0c8',
    'wisdom-note': '\uf005',
};

function getWikiNodeStyle(tipo) {
    return WIKI_NODE_COLORS[tipo] || WIKI_NODE_COLORS['assertion'];
}

// (A) Layout seed: ogni tipo ha una regione di partenza nel canvas
// per ridurre il caos iniziale del force-directed layout
const WIKI_TYPE_LAYOUT = {
    persona:        { angle: 0,    radius: 320 },
    organizzazione: { angle: 60,   radius: 320 },
    location:       { angle: 120,  radius: 320 },
    agreement:      { angle: 180,  radius: 320 },
    asset:          { angle: 240,  radius: 320 },
    event:          { angle: 300,  radius: 320 },
    source:         { angle: 30,   radius: 480 },
    assertion:      { angle: 150,  radius: 480 },
    'wisdom-note':  { angle: 270,  radius: 480 },
};

function buildWikiVisDatasets(graphData, typeFilter) {
    const nodes = [];
    const edges = [];

    // Conta quante note per tipo per distribuire angolarmente
    const typeCounters = {};
    const visibleIds = new Set();

    graphData.nodes.forEach(n => {
        if (typeFilter !== 'all' && n.type !== typeFilter) return;
        visibleIds.add(n.id);
        typeCounters[n.type] = (typeCounters[n.type] || 0) + 1;
    });

    // Indice corrente per ogni tipo (per distribuire lungo l'arco)
    const typeIndex = {};

    graphData.nodes.forEach(n => {
        if (!visibleIds.has(n.id)) return;
        const style = getWikiNodeStyle(n.type);
        const layout = WIKI_TYPE_LAYOUT[n.type] || { angle: 0, radius: 350 };
        const count = typeCounters[n.type] || 1;
        const idx = typeIndex[n.type] || 0;
        typeIndex[n.type] = idx + 1;
        // Distribuisce i nodi lungo un arco di 50° attorno all'angolo del tipo
        const spread = Math.min(50, count * 6);
        const angleOffset = count > 1 ? (idx / (count - 1) - 0.5) * spread : 0;
        const rad = (layout.angle + angleOffset) * Math.PI / 180;
        const jitter = (Math.random() - 0.5) * 60;

        // (B-lite) Spessore bordo proporzionale alle connessioni del nodo
        const conns = n.connections || 0;
        const nodeSize = 16 + Math.min(conns, 14) * 1.8;
        const borderW = conns > 5 ? 2.5 : conns > 2 ? 2 : 1.5;

        nodes.push({
            id: n.id,
            label: n.label.length > 22 ? n.label.slice(0, 20) + '…' : n.label,
            fullLabel: n.label,
            title: n.label,
            color: { background: style.bg, border: style.border, highlight: { background: style.bg, border: '#fff' } },
            font: { color: style.font, size: 11, face: 'Inter' },
            borderWidth: borderW,
            borderWidthSelected: borderW + 1.5,
            size: nodeSize,
            shape: 'dot',
            // Posizione iniziale stratificata per tipo (Proposta A)
            x: Math.cos(rad) * layout.radius + jitter,
            y: Math.sin(rad) * layout.radius + jitter,
            _raw: n
        });
    });

    graphData.edges.forEach((e, idx) => {
        if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) return;
        // (B-lite) Spessore arco basato sul grado medio dei due nodi connessi
        const fromNode = graphData.nodes.find(n => n.id === e.from);
        const toNode   = graphData.nodes.find(n => n.id === e.to);
        const avgDeg = ((fromNode?.connections || 0) + (toNode?.connections || 0)) / 2;
        const edgeWidth = avgDeg > 8 ? 2.5 : avgDeg > 4 ? 1.8 : 1;

        edges.push({
            id: idx,
            from: e.from,
            to: e.to,
            color: { color: 'rgba(148,163,184,0.22)', highlight: 'rgba(129,140,248,0.9)' },
            width: edgeWidth,
            smooth: { type: 'dynamic' }   // dynamic: gli archi seguono i nodi in tempo reale senza fisica
        });
    });

    return { nodes, edges };
}

function renderWikiGraph(graphData) {
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
        const container = document.getElementById('wiki-graph-canvas');
        if (container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#475569;font-size:0.8rem;"><i class="fa-solid fa-circle-info" style="margin-right:8px;"></i>Nessuna nota validata nel wiki.</div>';
        return;
    }

    // Precalcola grado di connessione per dimensionare i nodi
    const degree = {};
    graphData.edges.forEach(e => {
        degree[e.from] = (degree[e.from] || 0) + 1;
        degree[e.to]   = (degree[e.to]   || 0) + 1;
    });
    graphData.nodes.forEach(n => { n.connections = degree[n.id] || 0; });

    let currentTypeFilter = 'all';
    const container = document.getElementById('wiki-graph-canvas');
    if (!container) return;

    // (C) Stato ego-network: traccia l'ID del nodo attualmente in focus
    let wikiEgoFocusId = null;

    // Applica o rimuove il dimming dell'ego-network
    function applyWikiEgoFocus(nodeId, nodesDataset, edgesDataset) {
        if (!nodeId) {
            // Reset: tutti i nodi tornano al loro colore originale
            const updates = nodesDataset.get().map(n => {
                const rawNode = graphData.nodes.find(r => r.id === n.id);
                const style = getWikiNodeStyle(rawNode?.type || 'assertion');
                return {
                    id: n.id,
                    color: { background: style.bg, border: style.border, highlight: { background: style.bg, border: '#fff' } },
                    font: { color: style.font, size: 11, face: 'Inter' },
                    opacity: 1
                };
            });
            nodesDataset.update(updates);
            edgesDataset.update(edgesDataset.get().map(e => ({
                id: e.id,
                color: { color: 'rgba(148,163,184,0.22)', highlight: 'rgba(129,140,248,0.9)' },
                width: e.width || 1
            })));
            return;
        }

        // Calcola i vicini diretti del nodo
        const neighborIds = new Set([nodeId]);
        const activeEdgeIds = new Set();
        edgesDataset.get().forEach(e => {
            if (e.from === nodeId || e.to === nodeId) {
                neighborIds.add(e.from);
                neighborIds.add(e.to);
                activeEdgeIds.add(e.id);
            }
        });

        // Aggiorna i nodi: vicini = vividi, altri = quasi invisibili
        const nodeUpdates = nodesDataset.get().map(n => {
            const isNeighbor = neighborIds.has(n.id);
            const rawNode = graphData.nodes.find(r => r.id === n.id);
            const style = getWikiNodeStyle(rawNode?.type || 'assertion');
            if (isNeighbor) {
                return { id: n.id,
                    color: { background: style.bg, border: style.border, highlight: { background: style.bg, border: '#fff' } },
                    font: { color: style.font, size: 11, face: 'Inter' },
                    opacity: 1 };
            } else {
                return { id: n.id,
                    color: { background: 'rgba(30,41,59,0.3)', border: 'rgba(100,116,139,0.2)' },
                    font: { color: 'rgba(148,163,184,0.25)', size: 11, face: 'Inter' },
                    opacity: 0.15 };
            }
        });
        nodesDataset.update(nodeUpdates);

        // Aggiorna gli archi: quelli del vicinato = evidenziati, altri = quasi invisibili
        const edgeUpdates = edgesDataset.get().map(e => {
            if (activeEdgeIds.has(e.id)) {
                return { id: e.id, color: { color: 'rgba(129,140,248,0.85)', highlight: 'rgba(129,140,248,1)' }, width: Math.max(e.width || 1, 2) };
            } else {
                return { id: e.id, color: { color: 'rgba(100,116,139,0.06)' }, width: 0.5 };
            }
        });
        edgesDataset.update(edgeUpdates);
    }

    function redrawWiki(typeFilter) {
        currentTypeFilter = typeFilter;
        wikiEgoFocusId = null;
        const { nodes, edges } = buildWikiVisDatasets(graphData, typeFilter);
        const nodesDS = new vis.DataSet(nodes);
        const edgesDS = new vis.DataSet(edges);

        // Fisica sempre attiva a bassa intensità: damping alto = assestamento rapido (<0.5s),
        // maxVelocity basso = nessun rimbalzo. A riposo costo CPU ~0%, durante drag = fluido.
        const options = {
            physics: {
                enabled: true,
                solver: 'barnesHut',
                barnesHut: {
                    gravitationalConstant: -1200,
                    centralGravity: 0.08,
                    springLength: 140,
                    springConstant: 0.02,
                    damping: 0.92,          // altissimo: assestamento in ~0.4s
                    avoidOverlap: 0.5
                },
                maxVelocity: 6,             // velocità massima ridotta: nessun rimbalzo
                minVelocity: 0.05,          // soglia di quiete: la fisica si sospende automaticamente
                stabilization: { enabled: true, iterations: 150, updateInterval: 25 }
            },
            interaction: {
                hover: true,
                tooltipDelay: 150,
                hideEdgesOnDrag: false,     // archi sempre visibili durante il drag
                keyboard: { enabled: true }
            },
            nodes: { shadow: { enabled: true, size: 6, color: 'rgba(0,0,0,0.3)' } },
            edges: { selectionWidth: 2.5, arrowStrikethrough: false }
        };

        if (wikiNetwork) {
            wikiNetwork.setData({ nodes: nodesDS, edges: edgesDS });
            wikiNetwork.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
        } else {
            wikiNetwork = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, options);
        }

        updateWikiStats(nodes.length, edges.length);
        // Nessuno spegnimento della fisica: rimane sempre attiva a bassa intensità.
        // Vis.js la mette in idle automaticamente quando minVelocity è raggiunta.

        // (C) Click su nodo → ego-network focus + apre drawer
        wikiNetwork.off('click');
        wikiNetwork.on('click', params => {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                if (wikiEgoFocusId === nodeId) {
                    // Secondo click sullo stesso nodo: reset focus
                    wikiEgoFocusId = null;
                    applyWikiEgoFocus(null, nodesDS, edgesDS);
                    closeWikiDrawer();
                } else {
                    wikiEgoFocusId = nodeId;
                    applyWikiEgoFocus(nodeId, nodesDS, edgesDS);
                    const rawNode = graphData.nodes.find(n => n.id === nodeId);
                    if (rawNode) openWikiDrawer(rawNode, graphData);
                }
            } else {
                // Click su sfondo: reset focus
                if (wikiEgoFocusId) {
                    wikiEgoFocusId = null;
                    applyWikiEgoFocus(null, nodesDS, edgesDS);
                }
                closeWikiDrawer();
            }
        });

        // Tasto ESC per resettare il focus
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && wikiEgoFocusId) {
                wikiEgoFocusId = null;
                applyWikiEgoFocus(null, nodesDS, edgesDS);
                closeWikiDrawer();
            }
        }, { once: false });

        // --- Pin nodo nella posizione di rilascio ---
        // Al dragEnd, il nodo viene fissato esattamente dove è stato lasciato.
        // La fisica rimane attiva per gli altri nodi liberi che si adattano attorno.
        // Le posizioni pinnate vengono azzerate solo dal Reset (redraw completo).
        wikiNetwork.off('dragEnd');
        wikiNetwork.on('dragEnd', (params) => {
            if (params.nodes && params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                const pos = wikiNetwork.getPositions([nodeId])[nodeId];
                if (pos) {
                    nodesDS.update({ id: nodeId, x: pos.x, y: pos.y, fixed: { x: true, y: true } });
                }
            }
        });
    }

    wikiGraphData = graphData;
    redrawWiki('all');

    // --- Filtri Tipo ---
    document.querySelectorAll('#wiki-type-filters .graph-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#wiki-type-filters .graph-filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            chip.querySelector('input').checked = true;
            redrawWiki(chip.dataset.type);
        });
    });

    // --- Ricerca con Zoom ---
    const searchInput = document.getElementById('wiki-graph-search');
    const searchClear = document.getElementById('wiki-graph-search-clear');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim().toLowerCase();
            if (!q || !wikiNetwork) return;
            const matched = graphData.nodes.find(n => n.label.toLowerCase().includes(q) || (n.id && n.id.toLowerCase().includes(q)));
            if (matched) {
                wikiNetwork.focus(matched.id, { scale: 1.8, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
                wikiNetwork.selectNodes([matched.id]);
                openWikiDrawer(matched, graphData);
            }
        });
        if (searchClear) {
            searchClear.addEventListener('click', () => {
                searchInput.value = '';
                if (wikiNetwork) { wikiNetwork.unselectAll(); wikiNetwork.fit({ animation: true }); }
            });
        }
    }

    // --- Reset completo: ridisegna il grafo da zero, ripristina filtri e stato UI ---
    const resetBtn = document.getElementById('wiki-graph-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        // Reset chip UI al filtro "Tutti"
        document.querySelectorAll('#wiki-type-filters .graph-filter-chip').forEach(c => {
            c.classList.remove('active');
            const inp = c.querySelector('input');
            if (inp) inp.checked = false;
        });
        const allChip = document.querySelector('#wiki-type-filters .graph-filter-chip[data-type="all"]');
        if (allChip) {
            allChip.classList.add('active');
            const inp = allChip.querySelector('input');
            if (inp) inp.checked = true;
        }
        // Hard redraw: ricostruisce il grafo con posizioni iniziali e filtro "all"
        redrawWiki('all');
        closeWikiDrawer();
        // Fit dopo stabilizzazione
        if (wikiNetwork) wikiNetwork.once('stabilizationIterationsDone', () => {
            wikiNetwork.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
        });
    });
}

function updateWikiStats(nNodes, nEdges) {
    const el = document.getElementById('wiki-graph-stats');
    if (!el) return;
    el.innerHTML = `
        <div class="graph-stat-item"><strong>${nNodes}</strong> nodi visualizzati</div>
        <div class="graph-stat-item"><strong>${nEdges}</strong> collegamenti</div>
        <div class="graph-stat-item"><strong>${wikiGraphData ? wikiGraphData.nodes.length : nNodes}</strong> note totali nel wiki</div>
    `;
}

function openWikiDrawer(node, graphData) {
    const drawer = document.getElementById('wiki-graph-drawer');
    if (!drawer) return;
    drawer.classList.add('open');

    // Badge tipo
    const style = getWikiNodeStyle(node.type);
    const badge = document.getElementById('wiki-drawer-icon');
    if (badge) {
        badge.style.background = style.bg;
        badge.style.color = style.border;
        badge.style.fontFamily = 'Inter';
        badge.style.fontSize = '0.65rem';
        badge.style.fontWeight = '700';
        badge.style.padding = '3px 8px';
        badge.style.borderRadius = '12px';
        badge.style.textTransform = 'uppercase';
        badge.textContent = node.type ? node.type.charAt(0).toUpperCase() + node.type.slice(1) : 'Nota';
    }

    // Titolo
    const titleEl = document.getElementById('wiki-drawer-title');
    if (titleEl) titleEl.textContent = node.label;

    // Meta badges
    const metaEl = document.getElementById('wiki-drawer-meta');
    if (metaEl) {
        const tags = (node.tags || []).map(t => `<span class="graph-drawer-badge" style="background:rgba(129,140,248,0.12);color:#818cf8;">${t}</span>`).join('');
        const adm = node.admiralty ? `<span class="graph-drawer-badge" style="background:rgba(52,211,153,0.1);color:#34d399;">${node.admiralty}</span>` : '';
        const date = node.date ? `<span class="graph-drawer-badge" style="background:rgba(255,255,255,0.05);color:#94a3b8;">${node.date}</span>` : '';
        metaEl.innerHTML = adm + date + tags;
    }

    // Preview
    const previewEl = document.getElementById('wiki-drawer-preview');
    if (previewEl) {
        const clean = (node.preview || '').replace(/#{1,6}\s/g, '').replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
        previewEl.textContent = clean || 'Nessuna anteprima disponibile.';
    }

    // Abilita pulsante per leggere la nota completa
    const actionEl = document.getElementById('wiki-drawer-action');
    const readFullBtn = document.getElementById('btn-wiki-read-full');
    if (actionEl && readFullBtn) {
        // Cerca la nota completa nell'elenco globale
        const fullNote = dbData && dbData.notes ? dbData.notes.find(n => n.filename === node.id) : null;
        if (fullNote) {
            actionEl.style.display = 'block';
            // Clona il bottone per rimuovere vecchi event listener
            const newBtn = readFullBtn.cloneNode(true);
            readFullBtn.parentNode.replaceChild(newBtn, readFullBtn);
            newBtn.addEventListener('click', () => {
                openNoteModal(fullNote);
            });
        } else {
            actionEl.style.display = 'none';
        }
    }

    // Link diretti (nodi connessi)
    const linksEl = document.getElementById('wiki-drawer-links');
    if (linksEl) {
        const connected = graphData.edges
            .filter(e => e.from === node.id || e.to === node.id)
            .map(e => e.from === node.id ? e.to : e.from)
            .map(id => graphData.nodes.find(n => n.id === id))
            .filter(Boolean);

        if (connected.length > 0) {
            const items = connected.slice(0, 12).map(c => {
                const s = getWikiNodeStyle(c.type);
                return `<div class="graph-drawer-link-item">
                    <div class="graph-drawer-link-dot" style="background:${s.border};"></div>
                    <span>${c.label}</span>
                    <span style="margin-left:auto;font-size:0.65rem;color:#475569;">${c.type || ''}</span>
                </div>`;
            }).join('');
            const more = connected.length > 12 ? `<div style="font-size:0.68rem;color:#475569;padding:4px 0;">+ altri ${connected.length - 12}…</div>` : '';
            linksEl.innerHTML = `<h4>Connessioni (${connected.length})</h4>${items}${more}`;
        } else {
            linksEl.innerHTML = '<h4>Connessioni</h4><div style="font-size:0.75rem;color:#475569;">Nodo isolato — nessun wikilink trovato.</div>';
        }
    }
}

function closeWikiDrawer() {
    const drawer = document.getElementById('wiki-graph-drawer');
    if (drawer) drawer.classList.remove('open');
    if (wikiNetwork) wikiNetwork.unselectAll();
}

// =====================================================================
// CONFLICT NETWORK — ACLED
// =====================================================================

let acledNetwork = null;
let acledGraphData = null;

const ACLED_EDGE_COLORS = {
    'Battles':                    { color: '#ef4444', highlight: '#fca5a5' },
    'Violence against civilians': { color: '#f97316', highlight: '#fdba74' },
    'Explosions/Remote violence': { color: '#eab308', highlight: '#fde047' },
    'Riots':                      { color: '#a855f7', highlight: '#d8b4fe' },
    'Protests':                   { color: '#3b82f6', highlight: '#93c5fd' },
    'Strategic developments':     { color: '#64748b', highlight: '#94a3b8' },
};

function getAcledEdgeColor(types) {
    const priority = ['Battles', 'Violence against civilians', 'Explosions/Remote violence', 'Riots', 'Protests', 'Strategic developments'];
    for (const p of priority) {
        if (types && types.some(t => t.toLowerCase() === p.toLowerCase())) {
            return ACLED_EDGE_COLORS[p] || ACLED_EDGE_COLORS['Strategic developments'];
        }
    }
    return ACLED_EDGE_COLORS['Strategic developments'];
}

function buildAcledVisDatasets(graphData, countryFilter, minWeight) {
    const nodes = [];
    const edges = [];

    const activeNodeIds = new Set();
    graphData.edges.forEach(e => {
        if (e.weight < minWeight) return;
        if (countryFilter !== 'all') {
            const fromNode = graphData.nodes.find(n => n.id === e.from);
            const toNode   = graphData.nodes.find(n => n.id === e.to);
            const countries = new Set([...(fromNode?.countries || []), ...(toNode?.countries || [])]);
            if (!countries.has(countryFilter)) return;
        }
        activeNodeIds.add(e.from);
        activeNodeIds.add(e.to);
    });

    graphData.nodes.forEach(n => {
        if (!activeNodeIds.has(n.id)) return;
        const size = 14 + Math.min(n.n_events, 50) * 0.5;
        const isFatal = n.total_fatalities > 0;
        nodes.push({
            id: n.id,
            label: n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label,
            title: n.label,
            shape: 'dot',
            size: size,
            color: {
                background: isFatal ? 'rgba(239,68,68,0.2)' : 'rgba(148,163,184,0.12)',
                border: isFatal ? '#ef4444' : '#64748b',
                highlight: { background: 'rgba(239,68,68,0.35)', border: '#fca5a5' }
            },
            font: { color: isFatal ? '#fca5a5' : '#94a3b8', size: 10, face: 'Inter' },
            borderWidth: isFatal ? 2 : 1,
            _raw: n
        });
    });

    graphData.edges.forEach((e, idx) => {
        if (e.weight < minWeight) return;
        if (!activeNodeIds.has(e.from) || !activeNodeIds.has(e.to)) return;
        const ec = getAcledEdgeColor(e.types);
        const width = Math.max(1, Math.min(10, 1 + Math.log2(e.weight + 1)));
        edges.push({
            id: idx,
            from: e.from, to: e.to,
            width: width,
            color: { color: ec.color + '99', highlight: ec.highlight, opacity: 0.75 },
            smooth: { type: 'continuous' },
            title: `Scontri: ${e.weight} | Vittime: ${e.fatalities}`,
            _raw: e
        });
    });

    return { nodes, edges };
}

function renderAcledGraph(graphData) {
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
        const container = document.getElementById('acled-graph-canvas');
        if (container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#475569;font-size:0.8rem;"><i class="fa-solid fa-circle-info" style="margin-right:8px;"></i>Nessun dato ACLED disponibile.</div>';
        return;
    }

    acledGraphData = graphData;
    let currentCountry = 'all';
    let currentMinWeight = 1;
    const container = document.getElementById('acled-graph-canvas');
    if (!container) return;

    // (C) Ego-network focus per ACLED
    let acledEgoFocusId = null;

    function applyAcledEgoFocus(nodeId, nodesDS, edgesDS) {
        if (!nodeId) {
            // Reset: tutti i nodi tornano al loro stato originale
            nodesDS.update(nodesDS.get().map(n => {
                const rawNode = graphData.nodes.find(r => r.id === n.id);
                const isFatal = rawNode && rawNode.total_fatalities > 0;
                return { id: n.id,
                    color: {
                        background: isFatal ? 'rgba(239,68,68,0.2)' : 'rgba(148,163,184,0.12)',
                        border: isFatal ? '#ef4444' : '#64748b',
                        highlight: { background: 'rgba(239,68,68,0.35)', border: '#fca5a5' }
                    },
                    font: { color: isFatal ? '#fca5a5' : '#94a3b8', size: 10, face: 'Inter' },
                    opacity: 1 };
            }));
            edgesDS.update(edgesDS.get().map(e => {
                const rawEdge = graphData.edges.find(r => r.from === e.from && r.to === e.to);
                const ec = getAcledEdgeColor(rawEdge?.types);
                return { id: e.id, color: { color: ec.color + '99', highlight: ec.highlight, opacity: 0.75 } };
            }));
            return;
        }

        const neighborIds = new Set([nodeId]);
        const activeEdgeIds = new Set();
        edgesDS.get().forEach(e => {
            if (e.from === nodeId || e.to === nodeId) {
                neighborIds.add(e.from);
                neighborIds.add(e.to);
                activeEdgeIds.add(e.id);
            }
        });

        nodesDS.update(nodesDS.get().map(n => {
            if (neighborIds.has(n.id)) {
                const rawNode = graphData.nodes.find(r => r.id === n.id);
                const isFatal = rawNode && rawNode.total_fatalities > 0;
                return { id: n.id,
                    color: {
                        background: isFatal ? 'rgba(239,68,68,0.25)' : 'rgba(148,163,184,0.18)',
                        border: isFatal ? '#ef4444' : '#94a3b8',
                    },
                    font: { color: isFatal ? '#fca5a5' : '#cbd5e1', size: 11, face: 'Inter' },
                    opacity: 1 };
            } else {
                return { id: n.id,
                    color: { background: 'rgba(15,23,42,0.3)', border: 'rgba(100,116,139,0.15)' },
                    font: { color: 'rgba(148,163,184,0.2)', size: 10, face: 'Inter' },
                    opacity: 0.12 };
            }
        }));

        edgesDS.update(edgesDS.get().map(e => {
            if (activeEdgeIds.has(e.id)) {
                const rawEdge = graphData.edges.find(r => r.from === e.from && r.to === e.to);
                const ec = getAcledEdgeColor(rawEdge?.types);
                return { id: e.id, color: { color: ec.highlight, highlight: ec.highlight }, width: Math.max((e.width || 1) + 1.5, 3) };
            } else {
                return { id: e.id, color: { color: 'rgba(100,116,139,0.05)' }, width: 0.5 };
            }
        }));
    }

    function redrawAcled(countryFilter, minWeight) {
        currentCountry = countryFilter;
        currentMinWeight = minWeight;
        acledEgoFocusId = null;
        const { nodes, edges } = buildAcledVisDatasets(graphData, countryFilter, minWeight);
        const nodesDS = new vis.DataSet(nodes);
        const edgesDS = new vis.DataSet(edges);

        // Fisica sempre attiva a bassa intensità (identico al wiki graph)
        const options = {
            physics: {
                enabled: true,
                solver: 'barnesHut',
                barnesHut: {
                    gravitationalConstant: -1800,
                    centralGravity: 0.08,
                    springLength: 160,
                    springConstant: 0.02,
                    damping: 0.92,
                    avoidOverlap: 0.5
                },
                maxVelocity: 8,
                minVelocity: 0.05,
                stabilization: { enabled: true, iterations: 120, updateInterval: 25 }
            },
            interaction: {
                hover: true,
                tooltipDelay: 150,
                hideEdgesOnDrag: false      // archi sempre visibili durante il drag
            },
            nodes: { shadow: { enabled: true, size: 8, color: 'rgba(0,0,0,0.4)' } },
            edges: { selectionWidth: 3, smooth: { type: 'dynamic' } }
        };

        if (acledNetwork) {
            acledNetwork.setData({ nodes: nodesDS, edges: edgesDS });
            acledNetwork.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
        } else {
            acledNetwork = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, options);
        }

        updateAcledStats(nodes.length, edges.length, graphData);
        // Nessuno spegnimento della fisica: Vis.js entra in idle automaticamente.

        // (C) Click su nodo ACLED → ego-network focus
        acledNetwork.off('click');
        acledNetwork.on('click', params => {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                if (acledEgoFocusId === nodeId) {
                    acledEgoFocusId = null;
                    applyAcledEgoFocus(null, nodesDS, edgesDS);
                    closeAcledDrawer();
                } else {
                    acledEgoFocusId = nodeId;
                    applyAcledEgoFocus(nodeId, nodesDS, edgesDS);
                    const rawNode = graphData.nodes.find(n => n.id === nodeId);
                    const connEdges = graphData.edges.filter(e => e.from === nodeId || e.to === nodeId);
                    if (rawNode) openAcledDrawer(rawNode, connEdges, graphData);
                }
            } else {
                if (acledEgoFocusId) {
                    acledEgoFocusId = null;
                    applyAcledEgoFocus(null, nodesDS, edgesDS);
                }
                closeAcledDrawer();
            }
        });

        // --- Pin nodo nella posizione di rilascio (ACLED) ---
        acledNetwork.off('dragEnd');
        acledNetwork.on('dragEnd', (params) => {
            if (params.nodes && params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                const pos = acledNetwork.getPositions([nodeId])[nodeId];
                if (pos) {
                    nodesDS.update({ id: nodeId, x: pos.x, y: pos.y, fixed: { x: true, y: true } });
                }
            }
        });
    }

    redrawAcled('all', 1);

    // --- Filtri Paese ---
    document.querySelectorAll('#acled-type-filters .graph-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#acled-type-filters .graph-filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            chip.querySelector('input').checked = true;
            redrawAcled(chip.dataset.country, currentMinWeight);
        });
    });

    // --- Slider Min. Scontri ---
    const slider = document.getElementById('acled-min-weight');
    const sliderVal = document.getElementById('acled-min-weight-val');
    if (slider) {
        const maxW = Math.max(...graphData.edges.map(e => e.weight), 1);
        slider.max = Math.min(maxW, 50);
        slider.addEventListener('input', () => {
            const v = parseInt(slider.value, 10);
            if (sliderVal) sliderVal.textContent = v;
            redrawAcled(currentCountry, v);
        });
    }

    // --- Ricerca con Zoom ---
    const searchInput = document.getElementById('acled-graph-search');
    const searchClear = document.getElementById('acled-graph-search-clear');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim().toLowerCase();
            if (!q || !acledNetwork) return;
            const matched = graphData.nodes.find(n => n.id.toLowerCase().includes(q));
            if (matched) {
                acledNetwork.focus(matched.id, { scale: 1.6, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
                acledNetwork.selectNodes([matched.id]);
                const connEdges = graphData.edges.filter(e => e.from === matched.id || e.to === matched.id);
                openAcledDrawer(matched, connEdges, graphData);
            }
        });
        if (searchClear) {
            searchClear.addEventListener('click', () => {
                searchInput.value = '';
                if (acledNetwork) { acledNetwork.unselectAll(); acledNetwork.fit({ animation: true }); }
            });
        }
    }

    // --- Reset completo ACLED: ridisegna da zero, ripristina filtri, slider e stato ---
    const resetBtn = document.getElementById('acled-graph-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        // Reset chip paese su "Tutti"
        document.querySelectorAll('#acled-type-filters .graph-filter-chip').forEach(c => {
            c.classList.remove('active');
            const inp = c.querySelector('input');
            if (inp) inp.checked = false;
        });
        const allChip = document.querySelector('#acled-type-filters .graph-filter-chip[data-country="all"]');
        if (allChip) {
            allChip.classList.add('active');
            const inp = allChip.querySelector('input');
            if (inp) inp.checked = true;
        }
        // Reset slider a 1
        const sl = document.getElementById('acled-min-weight');
        const slVal = document.getElementById('acled-min-weight-val');
        if (sl) sl.value = 1;
        if (slVal) slVal.textContent = '1';
        // Hard redraw
        redrawAcled('all', 1);
        closeAcledDrawer();
        if (acledNetwork) acledNetwork.once('stabilizationIterationsDone', () => {
            acledNetwork.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
        });
    });
}

function updateAcledStats(nNodes, nEdges, graphData) {
    const el = document.getElementById('acled-graph-stats');
    if (!el) return;
    const totalFatalities = graphData.edges.reduce((s, e) => s + (e.fatalities || 0), 0);
    const legend = Object.entries(ACLED_EDGE_COLORS).map(([k, v]) =>
        `<span style="display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${v.color};display:inline-block;"></span><span style="font-size:0.65rem;color:#64748b;">${k}</span></span>`
    ).join('');
    el.innerHTML = `
        <div class="graph-stat-item"><strong>${nNodes}</strong> attori visualizzati</div>
        <div class="graph-stat-item"><strong>${nEdges}</strong> relazioni di scontro</div>
        <div class="graph-stat-item"><strong>${totalFatalities}</strong> vittime totali nel periodo</div>
        <div class="graph-stat-item" style="margin-left:auto;">
            <span style="display:inline-flex;gap:8px;flex-wrap:wrap;">${legend}</span>
        </div>
    `;
}

function openAcledDrawer(node, connectedEdges, graphData) {
    const drawer = document.getElementById('acled-graph-drawer');
    if (!drawer) return;
    drawer.classList.add('open');

    const titleEl = document.getElementById('acled-drawer-title');
    if (titleEl) titleEl.textContent = node.label;

    const metaEl = document.getElementById('acled-drawer-meta');
    if (metaEl) {
        const countries = (node.countries || []).map(c => `<span class="graph-drawer-badge" style="background:rgba(248,113,113,0.1);color:#f87171;">${c}</span>`).join('');
        const events = `<span class="graph-drawer-badge" style="background:rgba(255,255,255,0.06);color:#94a3b8;">⚡ ${node.n_events} eventi</span>`;
        const fatal = node.total_fatalities > 0 ? `<span class="graph-drawer-badge" style="background:rgba(239,68,68,0.15);color:#ef4444;">☠️ ${node.total_fatalities} vittime</span>` : '';
        metaEl.innerHTML = countries + events + fatal;
    }

    const previewEl = document.getElementById('acled-drawer-preview');
    if (previewEl) {
        const types = node.event_types || [];
        if (types.length > 0) {
            previewEl.innerHTML = '<strong style="color:#94a3b8;font-size:0.7rem;">TIPOLOGIE EVENTO REGISTRATE</strong><br>' +
                types.map(t => {
                    const ec = getAcledEdgeColor([t]);
                    return `<span style="display:inline-flex;align-items:center;gap:5px;margin:3px 0;"><span style="width:7px;height:7px;border-radius:50%;background:${ec.color};display:inline-block;"></span><span style="font-size:0.77rem;color:#cbd5e1;">${t}</span></span>`;
                }).join('<br>');
        } else {
            previewEl.textContent = 'Nessun tipo di evento registrato.';
        }
    }

    const linksEl = document.getElementById('acled-drawer-links');
    if (linksEl) {
        if (connectedEdges.length > 0) {
            const sorted = [...connectedEdges].sort((a, b) => b.weight - a.weight);
            const items = sorted.slice(0, 10).map(e => {
                const opponent = e.from === node.id ? e.to : e.from;
                const oppNode = graphData.nodes.find(n => n.id === opponent);
                const ec = getAcledEdgeColor(e.types);
                const lastDate = e.last_date ? ` <span style="font-size:0.65rem;color:#475569;">${e.last_date}</span>` : '';
                return `<div class="graph-drawer-link-item">
                    <div class="graph-drawer-link-dot" style="background:${ec.color};"></div>
                    <span style="flex:1;">${oppNode ? oppNode.label : opponent}</span>
                    <span style="color:#94a3b8;font-size:0.7rem;">${e.weight} scontri</span>
                    ${lastDate}
                </div>`;
            }).join('');
            const more = sorted.length > 10 ? `<div style="font-size:0.68rem;color:#475569;padding:4px 0;">+ altri ${sorted.length - 10}…</div>` : '';
            linksEl.innerHTML = `<h4>Scontri registrati (${connectedEdges.length} relazioni)</h4>${items}${more}`;
        } else {
            linksEl.innerHTML = '<h4>Scontri</h4><div style="font-size:0.75rem;color:#475569;">Nessuno scontro bilaterale trovato.</div>';
        }
    }
}

function closeAcledDrawer() {
    const drawer = document.getElementById('acled-graph-drawer');
    if (drawer) drawer.classList.remove('open');
    if (acledNetwork) acledNetwork.unselectAll();
}
