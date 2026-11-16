# Come funziona

## I tre pezzi

```
          ┌──────────────────────── server ─────────────────────────┐
 API  ──► │ collector.php ──► cache/<fonte>.geojson ──► modulo      │ ──► browser
 IoT      │ (cron/systemd)    (scrittura atomica)       "realtime"  │     realtime-layers.js
          └──────────────────────────────────────────────────────────┘
```

### 1. Raccoglitore (`collector.php`)

È **l'unico** componente che interroga le fonti esterne. Legge `sources.json`; per ogni fonte
scarica i dati con il suo intervallo, li converte in GeoJSON, filtra per area (`bbox`), tiene
solo i campi utili e scrive `cache/<id>.geojson` in modo atomico (file temporaneo + rinomina,
così il modulo non legge mai un file a metà).

- Se una fonte non risponde, il file precedente resta: il browser mostra il livello come
  "dato non aggiornato" (attenuato, pallino arancione). Il raccoglitore riprova con attese
  crescenti fino a 10 minuti, per non martellare una fonte in difficoltà.
- Se `sources.json` cambia, lo rilegge da solo. Se il nuovo file contiene un errore,
  continua con la configurazione precedente e lo scrive nel log.
- Tiene un lucchetto (`cache/.collector.lock`): può esserci **un solo** raccoglitore attivo.

### 2. Modulo Lizmap `realtime`

Vive dentro Lizmap e ne usa sessione, login e diritti. Due indirizzi:

| URL | Risposta |
|---|---|
| `index.php/realtime/default/config?repository=R&project=P` | la configurazione dei livelli del progetto, **già filtrata** per l'utente |
| `index.php/realtime/default/data?repository=R&project=P&layers=demo:0,meteo:1731590000` | i dati dei livelli richiesti, solo se cambiati dall'ultima volta |

Controlli: accesso al progetto (come Lizmap: diritti sul repository e gruppi autorizzati del
progetto) e, per i livelli con `"groups"`, appartenenza a uno dei gruppi (gli amministratori
vedono tutto). Un livello non permesso non compare nella configurazione e, se richiesto
direttamente, risponde `forbidden`. Se nessun livello è cambiato la risposta è `204` (vuota).

La configurazione si legge da `<repository>/media/realtime/<progetto>.json` e, se non esiste,
da `<repository>/media/realtime/default.json`.

### 3. Motore nel browser (`realtime-layers.js`)

Caricato da Lizmap come JavaScript personalizzato del repository. All'avvio chiede la
configurazione al modulo e:

- crea i gruppi e i livelli **in cima** al pannello Layer (gruppi esterni di Lizmap);
- disegna icone di legenda dallo stile, aggiunge l'icona "i" che apre il pannello
  **Information** nativo (stesso aspetto e alternanza con i metadati dei layer del progetto);
- a ogni ciclo fa **una sola** richiesta per tutti i livelli accesi, visibili alla scala
  corrente e scaduti; nulla se la scheda del browser è in background;
- aggiorna la **barra di stato** in basso (pallino lampeggiante) e il pannello Information;
- applica le viste: con `themes` un livello si accende o si spegne quando si sceglie una vista.

## Carico

| Chi | Quante richieste |
|---|---|
| fonti esterne | 1 ogni `interval` secondi per fonte, **qualunque sia il numero di utenti** |
| server Lizmap | 1 per utente ogni ciclo, solo se ha livelli accesi; risposta 204 se nulla è cambiato |
| browser | 0 a scheda nascosta o con i livelli spenti/fuori scala |

## Livelli "plugin"

Alcuni livelli richiedono un disegno particolare (esempio: bus animati con itinerario). In quel
caso il JSON dichiara `"plugin": "bus"` e il disegno lo fa uno script dedicato; il framework
gestisce comunque casella, metadati, viste, opacità, export, zoom e barra di stato.
Vedi [plugin.md](plugin.md).

## Perché il raccoglitore deve restare acceso (cron)

Il raccoglitore è un processo che gira di continuo. Va avviato in automatico e riavviato se
si ferma. Ci sono tre modi:

| Metodo | Serve l'amministratore? | Riparte dopo riavvio del server? | Resta attivo dopo il logout? |
|---|---|---|---|
| **cron dell'utente** (consigliato senza sudo) | no | sì, entro 1 minuto | sì |
| systemd di sistema | sì (sudo) | sì | sì |
| systemd `--user` | no, ma serve "linger" (lo abilita solo l'amministratore) | no senza linger | no senza linger |

Con cron basta una riga che lancia il raccoglitore **ogni minuto**: la prima volta parte, nei
minuti successivi trova il lucchetto occupato ed esce subito senza fare nulla (costo:
qualche millisecondo al minuto). Se il processo muore, al minuto successivo cron lo riavvia.
Non serve `flock`, `logrotate` né altro: lucchetto e rotazione del log sono dentro `collector.php`.
