# Verlezza Vision TV — Downloader e aggiornamenti

Codice stabile da usare su Downloader: **3875230**.

Destinazione registrata su AFTVnews:
https://github.com/Br174/streamflix-BV/releases/latest/download/Visionflix_BV_TV.apk

Il nome dell'asset pubblico resta intenzionalmente `Visionflix_BV_TV.apk`: in questo modo il codice Downloader non cambia anche se il nome visibile dell'app è **Verlezza Vision**.

Il precedente codice **6847755** resta collegato alla vecchia build 28 e non va usato per le versioni future.

## Versione pubblicata

Il 12 settembre 2026 è stata pubblicata **Verlezza Vision TV 1.7.240 (versionCode 169)**:

https://github.com/Br174/streamflix-BV/releases/tag/verlezza-tv-169

Il download anonimo dal collegamento `releases/latest/download/Visionflix_BV_TV.apk` è stato verificato dopo la pubblicazione: 39.849.624 byte, SHA-256 `5a41c52bdc5c19c7ae00be223ae5e55b6a024ebb1d1d78df035219188aa46b3a`.

Sono stati verificati integrità, certificato, versione, nome Verlezza Vision, launcher TV e presenza del nuovo banner. Installazione e funzionamento sul dispositivo finale restano da verificare.

## Automatismo

Il progetto privato `Br174/Visionflix` compila automaticamente Mobile e TV a ogni push su `main`.

Per la TV il workflow:

1. aumenta automaticamente `versionCode` e `versionName` in CI;
2. seleziona esplicitamente la chiave conservata dal workflow e ne verifica il certificato, evitando il percorso predefinito del runner;
3. compila l'APK TV con application ID `com.br174.visionflix.tv.debug`;
4. verifica firma, package, entry point TV e versionCode;
5. salva gli APK come artifact GitHub Actions;
6. aggiorna anche la release privata `tv-latest` del progetto sorgente;
7. se è configurato il secret `PUBLISH_TOKEN`, pubblica automaticamente una nuova release **Latest** nel repository pubblico `Br174/streamflix-BV`, allegando l'APK con il nome fisso `Visionflix_BV_TV.apk`.

Quando il punto 7 è attivo, il codice **3875230** segue sempre l'ultima APK TV pubblicata: non serve creare un nuovo codice Downloader ad ogni versione.

## Firma e banner TV

Dalla build **168** il workflow seleziona esplicitamente la chiave conservata dal progetto. Il certificato SHA-256 atteso è:

`55d9c2dc94f32e6b7685994f2652eec3d8086432e9de94e0645a8bf30f41918e`

La diagnosi del 12 settembre 2026 ha rilevato che le vecchie build usavano una chiave temporanea in `~/.config/.android/debug.keystore`, diversa da quella conservata in `~/.android/debug.keystore`. I certificati delle build 28, 29 e 35 erano tutti diversi.

**Le nuove build non possono aggiornare direttamente quelle vecchie installazioni.** Rimuovere la vecchia app può cancellare dati e preferenze: salvarli prima. Il vecchio APK resta nella release `bv-tv-build28`.

Le prossime compilazioni devono mantenere il certificato qui indicato. In caso di cache assente o diversa, il workflow si ferma e non genera una nuova chiave. Conservare anche un backup sicuro della chiave: la cache GitHub può essere eliminata.

Dalla build **169**, il banner TV usa il logo WebP valido su sfondo nero in formato 16:9. Il precedente PNG della grafica aggiornata aveva una struttura danneggiata e non è più referenziato dal launcher TV.

## Autorizzazione una tantum

Nel repository privato `Br174/Visionflix` deve esistere un Actions secret chiamato `PUBLISH_TOKEN`. Deve contenere un fine-grained GitHub token autorizzato sul solo repository `Br174/streamflix-BV` con permesso **Contents: Read and write**.

Il token non va scritto nei sorgenti, nei log o in chat.

La build 169 del 12 settembre 2026 ha ancora segnalato `PUBLISH_TOKEN non configurato`: la compilazione riesce, ma non aggiorna da sola il download pubblico. Modificare nome e grafica o pubblicare una release privata non sostituisce l'APK del repository pubblico.

In assenza di quel secret, l'APK verificato viene pubblicato con il workflow pubblico `.github/workflows/publish-visionflix-tv.yml`, aggiornando versione, URL dell'archivio e SHA-256 della nuova build. Questo passaggio è manuale e non attiva l'automatismo tra i due repository.

## Regole da non cambiare

- mantenere il link `releases/latest/download/Visionflix_BV_TV.apk`;
- mantenere il nome asset `Visionflix_BV_TV.apk`;
- mantenere l'application ID TV `com.br174.visionflix.tv.debug`;
- mantenere la stessa firma per gli aggiornamenti della stessa app;
- usare sempre il codice Downloader **3875230**.
