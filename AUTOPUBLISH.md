# Pubblicazione automatica di Verlezza Vision TV

Questa procedura aggiorna il file seguito dal codice Downloader **3875230** usando i collegamenti GitHub e Higgsfield già autorizzati. Il controllo periodico viene eseguito da ChatGPT Work; il workflow GitHub pubblico verifica e pubblica l'APK.

## Ambito autorizzato

- Sorgente privata: `Br174/Visionflix`, ramo `main`, workflow `.github/workflows/build-apks.yml`.
- Destinazione pubblica: `Br174/streamflix-BV`, ramo `main`.
- File da aggiornare a ogni nuova versione: `release-manifest.json`.
- Nome dell'asset: `Visionflix_BV_TV.apk`.
- Package: `com.br174.visionflix.tv.debug`.
- Nome dell'app: `Verlezza Vision`.
- Certificato SHA-256: `55d9c2dc94f32e6b7685994f2652eec3d8086432e9de94e0645a8bf30f41918e`.
- Collegamento stabile: https://github.com/Br174/streamflix-BV/releases/latest/download/Visionflix_BV_TV.apk

Non pubblicare sorgenti privati, chiavi di firma, credenziali, APK Mobile o artefatti di altri progetti. Non rigenerare firme, non cambiare package e non abbassare i controlli. Le correzioni al codice dell'app restano fuori dall'ambito di questo automatismo.

## Una esecuzione del controllo

1. Leggere il manifesto pubblico, la release pubblica Latest e il commit corrente di `Br174/Visionflix/main`. Cercare la più recente esecuzione del workflow di compilazione su main. Se la build corrente è ancora in corso, attendere il controllo successivo. Non selezionare branch di prova, pull request o run diagnostici.
2. La build candidata deve essere conclusa con successo e riferita al commit corrente di main. Verificare che il passaggio **Verify Android TV APK** sia riuscito e ricavare dai log versione, versionCode, nome, package e certificato. Il warning relativo al solo `PUBLISH_TOKEN` assente è previsto: questa procedura effettua la pubblicazione con l'accesso collegato.
3. Se la release pubblica contiene già quella versione verificata, terminare senza modifiche né notifiche. Non pubblicare sopra una release Verlezza con versionCode superiore. Se esiste una pubblicazione già in corso per la stessa versione, verificarne l'esito invece di avviarne una duplicata.
4. Recuperare l'artefatto `Verlezza-Vision-debug-APKs` mediante il collegamento GitHub. Registrare run ID, artifact ID, commit e SHA-256 dell'archivio restituito da GitHub. I collegamenti temporanei dell'artefatto non vanno scritti nel repository, nel manifesto o nelle notifiche.
5. Preparare un archivio di distribuzione con il solo `Verlezza-Vision-TV.apk`, rinominato al suo interno `Visionflix_BV_TV.apk`. Verificare prima lo SHA-256 dell'archivio sorgente contro il valore GitHub e calcolare lo SHA-256 dell'APK.
6. Per il passaggio del file già autorizzato: chiamare Higgsfield `media_upload` con nome `verlezza-vision-tv-<versionCode>.zip` prima di produrre il file. In un solo `sandbox_exec`, scaricare l'artefatto temporaneo, verificarlo, estrarre solo la TV, creare lo ZIP di distribuzione e caricarlo con HTTP PUT nell'upload URL ottenuto. Il Content-Type deve corrispondere a quello restituito dal servizio. Chiamare `media_confirm` con `type: file` solo dopo HTTP 200. Questa operazione confeziona un archivio; non genera né modifica immagini e non modifica o firma l'APK.
7. Aggiornare il manifesto con versione reale, checksum APK, URL permanente dello ZIP confermato e provenienza GitHub. Usare il blob SHA corrente del file e preservare eventuali aggiornamenti concorrenti. Se il dominio del servizio cambia, non indebolire automaticamente la whitelist: segnalare il cambio.
8. Il push del manifesto avvia `publish-visionflix-tv.yml`. Attendere il completamento e controllare l'esito. GitHub verifica checksum, certificato, nome, package, versione e launcher TV. Rifiuta collisioni con APK diversi, evita regressioni di versione e completa gli asset in bozza prima di rendere pubblica una nuova release.
9. Prima di annunciare il successo, verificare la release Latest, il suo asset e il download anonimo dal collegamento stabile: lo SHA-256 deve coincidere con quello candidato. Notificare Bruno in italiano solo per una nuova pubblicazione riuscita o un nuovo blocco concreto. Non inviare messaggi ripetitivi quando non cambia nulla.

## Frequenza e prerequisiti

Il controllo orario è periodico, non un webhook della compilazione. La nuova versione viene pubblicata quando il controllo rileva una build completata e verificata; non è una pubblicazione istantanea al push.

I collegamenti autorizzati e l'attività programmata devono restare attivi. Un problema di accesso richiede una segnalazione, non tentativi di aggirare permessi o controlli. Il token `PUBLISH_TOKEN` rimane un'alternativa facoltativa per la pubblicazione immediata direttamente dal workflow privato e non serve al percorso tramite Work.

La chiave di firma deve restare quella esistente; la cache GitHub non sostituisce un backup sicuro. In caso di chiave assente o diversa, la compilazione si ferma e l'automatismo conserva l'ultima versione pubblica valida.
