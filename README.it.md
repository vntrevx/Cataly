# Cataly

**Capire l'intento. Leggere il contesto. Portare il lavoro fino in fondo.**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [中文](README.zh.md)

Cataly è un compagno di squadra AI che porta il lavoro dall'obiettivo al completamento.
Digli cosa vuoi realizzare: si fa carico dei passi successivi, tiene conto del
contesto e prosegue fino a un risultato che puoi verificare.

L'ambizione non è soltanto seguire le istruzioni, ma esercitare buon giudizio:
riconoscere ciò che conta, collegare i dettagli e gestire il lavoro senza
dover essere guidato un passo alla volta.

## La filosofia

- **Farsi carico del risultato.** Lavorare per raggiungere l'obiettivo, non per
  spuntare un elenco di attività.
- **Capire il contesto.** Tenere presenti la conversazione, le convenzioni del
  progetto, i vincoli e le preferenze dell'utente.
- **Prendere iniziative ponderate.** Gestire autonomamente le decisioni ordinarie.
  Chiedere quando un vero compromesso o un permesso mancante richiedono il giudizio dell'utente.
- **Portare il lavoro fino in fondo.** Indagare, implementare, verificare e riferire
  ciò che è realmente accaduto. Una spiegazione convincente non sostituisce un risultato funzionante.

Questo è il criterio su cui si fonda Cataly: la capacità di agire, l'attenzione
necessaria per capire e la responsabilità del risultato.

## Come funziona

Cataly collega le conversazioni nelle app di messaggistica a un runtime nativo
per coding agent e a lane di lavoro tracciate:

- Il lead gestisce direttamente le piccole richieste e assegna ai lavori più lunghi
  un brief, una sessione dedicata e un responsabile che ne risponde.
- Worklog, checkpoint e registri rendono i progressi consultabili anche dopo i riavvii.
- La ricezione da Discord porta nel lavoro il contesto delle risposte e i metadati degli allegati.
- I record di sessione e approvazione legati al processo proteggono la consegna all'agente previsto.
- I controlli di completamento possono verificare segnali concreti, come comandi
  riusciti, file corrispondenti, pull request integrate o versioni pubblicate.
- Pianificazione, monitor e supervisione facoltativi supportano il lavoro
  continuativo quando vengono abilitati esplicitamente.

L'implementazione riunisce
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi) e
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). Autori, licenze e provenienza
dei sorgenti restano parte del progetto.

## Per iniziare

Cataly è il nome del progetto. I comandi esistenti `dori`, `omp-dori` e `omp`,
le directory di installazione e i nomi degli asset pubblicati non sono stati rinominati.

### Lavorare dai sorgenti

Installa prima git, Bun 1.4.4+ e herdr o hc; consulta i
[prerequisiti della versione sorgente](docs/releases.md#current-source-bundle).

Usa un checkout separato, non un'installazione in esecuzione o una release utente congelata:

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

L'installer da sorgente prepara OMP 18.22.2 con le modifiche e i vincoli del progetto
e l'overlay ULW; un `omp` standard nel `PATH` non può sostituirli. La modalità side
usa per impostazione predefinita `~/.omp-dori`, mantiene wrapper e configurazione
propri e lascia intatta l'installazione primaria `~/.dori`.
L'installazione non avvia agenti, ricevitori di messaggi o servizi.

Leggi la [guida all'installazione da sorgente](docs/releases.md#source-checkouts-for-maintainers)
per isolamento, configurazione e avvio esplicito. Le sessioni native
usano la tua autenticazione presso il provider e la tua quota di utilizzo.

### Usare una release pubblicata

La **prerelease v0.1.2** esistente ha un contratto immutabile per
Linux x64 / herdr / Discord. Rinominare il repository non aggiorna quegli asset
né introduce il supporto per nuove piattaforme.

Segui la [guida verificata alla release esatta](docs/releases.md#prerequisites-and-trust).
Include prerequisiti, checksum, installazione, la tua autenticazione,
avvio esplicito e monitor Discord da abilitare su scelta dell'utente.
Non sostituire una release esatta con un installer arbitrario di `main`.

L'implementazione per gli utenti supporta anche profili isolati macOS arm64 / hc
quando un manifest di release verificato li dichiara. Questo non significa che sia
stata pubblicata una release macOS. Slack e Telegram restano funzionalità della versione sorgente.

## Principi operativi

Cataly lavora con gli account e i permessi che fornisci. Le azioni con effetti
esterni richiedono l'autorizzazione pertinente: ritenere utile un'azione
non conferisce il permesso di eseguirla. Abilita soltanto le sessioni, i monitor
e i servizi che intendi usare.

La verifica ha dei limiti. Un segnale di completamento soddisfatto è una prova
di quel segnale, non una garanzia su ogni risultato. I rapporti dovrebbero
distinguere i risultati osservati, l'incertezza residua e il lavoro non svolto.

Tieni credenziali, conversazioni private e dati degli account fuori da patch
e rapporti pubblici. La telemetria facoltativa può essere disabilitata con
`DORI_TELEMETRY=0` o `DO_NOT_TRACK=1`.

## Documentazione

- [Installazione, supporto, aggiornamenti e rollback](docs/releases.md)
- [Skill e regole operative](skills/dori-mode/SKILL.md)
- [Configurazione della messaggistica](skills/dori-mode/references/setup.md)
- [Adattatori runtime e contratti delle sessioni](docs/runtime.md)
- [Configurazione dei container](docs/container.md)
- [Pianificazione e backlog](docs/hourly-loop.md)
- [Lock condivisi e priorità delle lane](docs/locks.md)
- [Contribuire](CONTRIBUTING.md)
- [Registro delle modifiche](CHANGELOG.md)
- [Licenze e attribuzione dei sorgenti](LICENSE) · [Guida alle licenze](LICENSING.md) · [Avviso sulla copia modificata](NOTICE)

## Contribuire

Porta un obiettivo chiaro, una modifica mirata e prove del suo funzionamento.
Parti dalla [guida ai contributi](CONTRIBUTING.md), controlla le
[issue esistenti](https://github.com/vntrevx/Cataly/issues) e le
[pull request](https://github.com/vntrevx/Cataly/pulls) e conserva il contesto
che ha reso necessaria la modifica.

## Licenza

Le licenze seguono la provenienza di ogni componente. Il materiale derivato da
dori-superagent conserva la [Sustainable Use License 1.0](LICENSE);
l'integrazione OMP preesistente conserva la propria
[licenza MIT e gli avvisi di copyright](LICENSE.omp-dori).
Gli altri componenti mantengono le rispettive condizioni. L'avviso MIT non
attribuisce una nuova licenza all'intero repository. [NOTICE](NOTICE) registra
le revisioni importate e l'attribuzione della copia modificata.
