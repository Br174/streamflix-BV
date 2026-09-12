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

## Automatismo attivo tramite Work

È attivo il controllo programmato **Aggiorna Verlezza Vision**, con frequenza **oraria**.

1. Il progetto privato `Br174/Visionflix` compila Mobile e TV a ogni push su `main`.
2. Il controllo di Work confronta l'ultima build riuscita del commit corrente con la release pubblica.
3. Quando trova una nuova versione verificata, trasferisce il solo APK TV mediante i collegamenti già autorizzati e aggiorna `release-manifest.json`.
4. Il workflow pubblico verifica archivio, checksum, firma, nome, package, versione e launcher TV, quindi pubblica la nuova release Latest.
5. Verifica anche il download anonimo dal collegamento stabile prima di annunciare il successo.

Il codice **3875230** rimane invariato. Il controllo è periodico: la pubblicazione avviene quando rileva la nuova build completata, non immediatamente a ogni modifica.

Questo percorso usa i collegamenti GitHub e Higgsfield già autorizzati e **non richiede il secret PUBLISH_TOKEN**. Il relativo warning nella compilazione privata riguarda solo il percorso diretto alternativo descritto più sotto.

Le build con firma diversa, versione errata, contenuto inatteso o collisioni con un asset esistente vengono bloccate. Una versione pubblica più recente non viene sostituita da una precedente.

Procedura operativa: [AUTOPUBLISH.md](AUTOPUBLISH.md). Dati della versione candidata: [release-manifest.json](release-manifest.json).

Il nuovo workflow è stato eseguito e verificato sulla versione 1.7.240 già pubblicata: riconosce la ripetizione, conserva l'APK esistente e verifica lo stesso download pubblico.

## Firma e banner TV

Dalla build **168** il workflow seleziona esplicitamente la chiave conservata dal progetto. Il certificato SHA-256 atteso è:

`55d9c2dc94f32e6b7685994f2652eec3d8086432e9de94e0645a8bf30f41918e`

La diagnosi del 12 settembre 2026 ha rilevato che le vecchie build usavano una chiave temporanea in `~/.config/.android/debug.keystore`, diversa da quella conservata in `~/.android/debug.keystore`. I certificati delle build 28, 29 e 35 erano tutti diversi.

**Le nuove build non possono aggiornare direttamente quelle vecchie installazioni.** Rimuovere la vecchia app può cancellare dati e preferenze: salvarli prima. Il vecchio APK resta nella release `bv-tv-build28`.

Le prossime compilazioni devono mantenere il certificato qui indicato. In caso di cache assente o diversa, il workflow si ferma e non genera una nuova chiave. Conservare anche un backup sicuro della chiave: la cache GitHub può essere eliminata.

Dalla build **169**, il banner TV usa il logo WebP valido su sfondo nero in formato 16:9. Il precedente PNG della grafica aggiornata aveva una struttura danneggiata e non è più referenziato dal launcher TV.

## Alternativa facoltativa: pubblicazione immediata da GitHub

Per pubblicare direttamente dal workflow privato al termine della compilazione, invece del controllo periodico di Work, si può configurare nel repository `Br174/Visionflix` un Actions secret `PUBLISH_TOKEN`: un fine-grained GitHub token limitato al repository pubblico `Br174/streamflix-BV`, con permesso **Contents: Read and write**.

Questa alternativa non è necessaria per l'automatismo orario attivo. Il token non va scritto nei sorgenti, nei log o in chat.

## Regole da non cambiare

- mantenere il link `releases/latest/download/Visionflix_BV_TV.apk`;
- mantenere il nome asset `Visionflix_BV_TV.apk`;
- mantenere l'application ID TV `com.br174.visionflix.tv.debug`;
- mantenere la stessa firma per gli aggiornamenti della stessa app;
- usare sempre il codice Downloader **3875230**.
